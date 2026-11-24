import * as Y from 'yjs';
import {
  Notebook,
  Page,
  emptyRegions,
  emptyThreads,
  encodeQinkUpdate,
  encodeQinkRead,
  encodeQinkThread,
  cleanAsk,
  migratePage,
  resolveTarget,
  resolveThread,
  renderRegionsSvg,
  threadLabel,
  encodeLectureRead,
  emptyLectures,
  lectureLine,
  parseLectureRef,
  resolveLecture,
  transcriptLine,
  fmtTExact,
  type BBox,
  type LectureCrop,
  type LectureMeta,
  type LectureReadPart,
  type QinkLectures,
  type InkSeen,
  type QinkImage,
  type QinkRegions,
  type QinkSeen,
  type QinkAsk,
  type QinkThreads,
} from '@qalm/core';
import type { Env } from './env';
import { lecDocId, nbDocId, pgDocId, room } from './docs';
import type { LectureInfo } from './lecture';
import type { DocRoom } from './room';

export interface AgentConfig { idleMs: number; minIntervalMs: number; timeoutMs: number }
/** Q-ink text plus, when regions need one, the image as SVG (the worker turns it into PNG). */
export interface AgentResult {
  text: string;
  svg: string | null;
  changed: boolean;
  error?: boolean;
  /** A lecture read: text and crop images (asset sha256) interleaved by time. Replaces text/svg in the MCP result. */
  parts?: LectureReadPart[];
}
export type AgentEdit =
  /** `ref`: a region `R7` or a box `p3@120,300,260,80`. */
  | { op: 'transcribe'; ref: string; text: string }
  /** A new thread on `ref`, or a reply in `thread` (optionally resolving it). */
  | { op: 'comment'; ref?: string; thread?: string; text: string; agentName: string; resolve?: boolean };
/** What the notebook room asks a page room to do. Agents never touch ink. */
export type PageEdit =
  /** The strokes are `ids` (a region's, those still on the page) or the ink in `box` (a box ref). */
  | { op: 'transcribe'; ref: string; text: string; ids?: string[]; box?: BBox; agentName?: string }
  /** A thread on a region's strokes (`ids`), a box's ink (`box`), or the whole page (neither). */
  | { op: 'comment'; ref: string; text: string; agentName: string; ids?: string[]; box?: BBox }
  | { op: 'reply'; ref: string; text: string; agentName: string; commentId: string; resolve?: boolean };

/** What one agent (OAuth client) has been sent from this notebook. */
interface AgentState {
  rev: number;
  /** Page changes at or before this time have been delivered. */
  deliveredAt: number;
  lastWakeAt: number;
  /** Number of `asks` entries already delivered. */
  askCount: number;
  /** Thread entries already seen (missing in states saved before threads existed). */
  seen?: QinkSeen;
  /** Transcript segments already sent, per lecture session (live lines, docs/lecture-mode.md §7). */
  lect?: Record<string, number>;
}

const agentKey = (clientId: string) => `agent:${clientId}`;
/** The ink this agent last saw on a page (stroke id → signature), one key per page to keep rows small. */
const inkKey = (clientId: string, pageId: string) => `ink:${clientId}:${pageId}`;

export const AI_OFF = 'AI access is off for this notebook. The student can turn it on in the notebook.';
export const PAUSED = "The student hasn't turned on AI for this notebook right now. Keep calling wait(s): it resumes when they press Play in qalm.";
/** An agent counts as following for this long after its last call. */
export const PRESENCE_MS = 60_000;
/** Live transcript lines per lecture in one wait update; a longer catch-up points at read("L…") for the rest. */
export const LIVE_LINES_MAX = 30;

/** The calling agent: OAuth client id, display name and what its grant allows. */
export interface AgentWho { clientId: string; name: string; canComment: boolean; canTranscribe: boolean }
interface Seen { name: string; at: number; canComment?: boolean; canTranscribe?: boolean }
export interface Presence {
  aiAccess: boolean;
  /** One of the owner's devices is playing AI sharing (Play / Pause AI). */
  live: boolean;
  /** `!live`, for apps from before Play / Pause. */
  paused: boolean;
  agents: { name: string; waiting: boolean; lastAt: number; canComment: boolean; canTranscribe: boolean }[];
}

/**
 * Lives in a notebook's DocRoom. Only this object assigns Q-ink labels, so they stay stable and unique.
 * Storage: `regions` (QinkRegions), `threads` (QinkThreads), `changed` (pageId → last client update),
 * `lastCommentAt` (the student's last comment or reply), `agent:{clientId}` (AgentState) and
 * `ink:{clientId}:{pageId}` (InkSeen: what the agent last saw of the page).
 */
export class AgentHub {
  private waiters = new Set<() => void>();
  private changed: Record<string, number>;

  constructor(private readonly r: DocRoom, private readonly env: Env, private readonly notebookId: string) {
    this.changed = r.kvGet<Record<string, number>>('changed') ?? {};
  }

  private nb(): Notebook {
    return new Notebook(this.r.doc);
  }

  private regions(): QinkRegions {
    return this.r.kvGet<QinkRegions>('regions') ?? emptyRegions();
  }

  private threads(): QinkThreads {
    return this.r.kvGet<QinkThreads>('threads') ?? emptyThreads();
  }

  /** The notebook's AI access switch, read live from the index doc. Unknown (never synced) counts as off. */
  aiAccess(): boolean {
    return this.nb().meta().aiAccess === true;
  }

  /**
   * THE gate for every MCP path (wait, read, transcribe, comment, and anything new such as Lecture mode's live
   * transcript): AI access is on and one of the owner's devices is playing AI sharing right now (a live heartbeat
   * on the notebook's sync socket; DocRoom.liveUntil). Paused or not open in qalm: agents get nothing.
   * The synced `aiPaused` flag that apps from before Play / Pause still write ("Pause sharing") pauses it too, so
   * Pause on an old device isn't ignored while a new one plays.
   */
  isLive(): boolean {
    return this.aiAccess() && this.nb().meta().aiPaused !== true && this.r.liveUntil() > 0;
  }

  /** Throws the message an agent should see when `isLive()` is false. */
  requireLive(): void {
    if (!this.aiAccess()) throw new Error(AI_OFF);
    if (!this.isLive()) throw new Error(PAUSED);
  }

  /** Play or Pause (or a device's heartbeat lapsing or its socket closing): pending waits re-check at once. */
  onLiveChanged(): void {
    this.wakeAll();
  }

  /**
   * THE check for every Lecture-mode output to MCP (docs/lecture-mode.md §7): live transcript lines in `wait`,
   * `read("L2")`, the outline's lecture lines and `lecture L2 recording` in the session list. Nothing about a lecture
   * reaches an agent unless this is true at the moment it goes out (re-checked after every await).
   *
   * Today: AI access on and sharing not paused. The Play / Pause AI work (a central `isLive()`: one of the student's
   * devices is playing AI for this notebook) plugs in here by making the body `return this.isLive();`.
   */
  lectureLive(): boolean {
    return this.aiAccess() && !this.paused();
  }

  /** Throws what the agent should see when `lectureLive()` is false. */
  private requireLectureLive(): void {
    if (!this.aiAccess()) throw new Error(AI_OFF);
    if (!this.lectureLive()) throw new Error(PAUSED);
  }

  // ---- presence: who is following this notebook ----

  /** Agent calls touch `presence` (kv: clientId → name, last call); pending waits are counted in memory. */
  private waiting = new Map<string, number>();

  private touch(who: AgentWho): void {
    const p = this.r.kvGet<Record<string, Seen>>('presence') ?? {};
    p[who.clientId] = { name: who.name, at: Date.now(), canComment: who.canComment, canTranscribe: who.canTranscribe };
    this.r.kvPut('presence', p);
  }

  /** Agents with a pending wait or a call in the last minute. Nobody while AI access is off. */
  presence(): Presence {
    const t = Date.now();
    const p = this.r.kvGet<Record<string, Seen>>('presence') ?? {};
    const agents = this.aiAccess()
      ? Object.entries(p)
          .filter(([id, a]) => (this.waiting.get(id) ?? 0) > 0 || t - a.at < PRESENCE_MS)
          .map(([id, a]) => ({ name: a.name, waiting: (this.waiting.get(id) ?? 0) > 0, lastAt: a.at, canComment: !!a.canComment, canTranscribe: !!a.canTranscribe }))
          .sort((a, b) => b.lastAt - a.lastAt)
      : [];
    const live = this.isLive();
    return { aiAccess: this.aiAccess(), live, paused: !live, agents };
  }

  lastClientUpdateAt(): number {
    return Math.max(0, this.r.kvGet<number>('lastClientUpdateAt') ?? 0);
  }

  /** `comment`: the student added a comment or reply. Like an Ask, that is delivered at once. */
  onPageChanged(pageId: string, at: number, comment = false): void {
    this.changed[pageId] = Math.max(this.changed[pageId] ?? 0, at);
    this.r.kvPut('changed', this.changed);
    this.r.kvPut('lastClientUpdateAt', Math.max(this.lastClientUpdateAt(), at));
    if (comment) this.r.kvPut('lastCommentAt', Math.max(this.r.kvGet<number>('lastCommentAt') ?? 0, at));
    this.wakeAll();
  }

  /** A client changed the index doc (maybe a new ask). */
  onIndexChanged(): void {
    this.wakeAll();
  }

  private wakeAll(): void {
    const ws = [...this.waiters];
    this.waiters.clear();
    for (const w of ws) w();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(t);
        this.waiters.delete(finish);
        resolve();
      };
      const t = setTimeout(finish, Math.max(0, ms));
      this.waiters.add(finish);
    });
  }

  private async loadPages(ids: string[]): Promise<Record<string, Page>> {
    const out: Record<string, Page> = {};
    await Promise.all(
      [...new Set(ids)].map(async (id) => {
        const docId = pgDocId(this.notebookId, id);
        const state = await room(this.env, docId).getState(docId);
        const doc = new Y.Doc();
        Y.applyUpdate(doc, state);
        migratePage(doc); // a page not opened since regions: read it as the app will store it (not written back)
        out[id] = new Page(doc);
      }),
    );
    return out;
  }

  private imageSvg(pages: Record<string, Page>, image: QinkImage | null): string | null {
    return image?.rows.length ? renderRegionsSvg(pages, image.rows).svg : null;
  }

  private state(clientId: string): AgentState {
    const st = this.r.kvGet<AgentState>(agentKey(clientId));
    if (st) return st;
    // A new agent starts now: earlier asks are not replayed, and the first wake is not rate-limited.
    return {
      rev: 0,
      deliveredAt: Date.now(),
      lastWakeAt: 0,
      askCount: this.nb().asks().length,
      // No replay of a lecture's transcript so far: lines start from now.
      lect: Object.fromEntries(Object.entries(this.lectures()).map(([sid, l]) => [sid, l.count])),
    };
  }

  // ---- lectures (docs/lecture-mode.md §7) ----

  private lectures(): Record<string, LectureInfo> {
    return this.r.kvGet<Record<string, LectureInfo>>('lectures') ?? {};
  }

  private lectureLabels(): QinkLectures {
    return this.r.kvGet<QinkLectures>('lectureLabels') ?? emptyLectures();
  }

  /** A session's transcript grew: transcript lines wake waits too (with the rate limit, not the pen-idle rule). */
  onLectureChanged(): void {
    this.wakeAll();
  }

  /** `lecture L2 recording 12:40` for the session list, or null when nothing records. */
  liveLecture(): string | null {
    if (!this.lectureLive()) return null;
    const labels = this.lectureLabels();
    const live = Object.entries(this.lectures())
      .filter(([, l]) => l.state !== 'stopped' && !l.expired)
      .sort((a, b) => b[1].startedAt - a[1].startedAt)[0];
    const label = live && labels.byId[live[0]];
    if (!live || !label) return null;
    const mm = Math.floor(live[1].durationMs / 60_000), ss = Math.floor((live[1].durationMs % 60_000) / 1000);
    return `lecture ${label} ${live[1].state} ${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  }

  private hasTranscriptNews(st: AgentState): boolean {
    if (!this.lectureLive()) return false;
    return Object.entries(this.lectures()).some(([sid, l]) => l.count > (st.lect?.[sid] ?? 0));
  }

  /**
   * New transcript segments per session since this agent's state, as Q-ink lines (and the counts to store). At most
   * `LIVE_LINES_MAX` lines per session per update: a long catch-up (e.g. after Play) ends with a `more:` pointer to
   * `read("L…")` from the first line left out, and the agent's position moves past all of them.
   */
  private async transcriptNews(st: AgentState): Promise<{ lines: string[]; lect: Record<string, number> }> {
    const lect = { ...st.lect };
    const labels = this.lectureLabels();
    const lines: string[] = [];
    for (const [sid, l] of Object.entries(this.lectures())) {
      const from = lect[sid] ?? 0;
      if (l.count <= from) continue;
      const label = labels.byId[sid];
      const docId = lecDocId(this.notebookId, sid);
      const { segs, next } = await room(this.env, docId).lectureTranscript(docId, from, LIVE_LINES_MAX + 1);
      const shown = segs.slice(0, LIVE_LINES_MAX);
      if (label) for (const seg of shown) lines.push(transcriptLine(label, seg));
      const rest = segs[LIVE_LINES_MAX];
      if (rest) {
        if (label) lines.push(`more: read("${label}@${fmtTExact(rest.t0)}")`);
        lect[sid] = Math.max(next, l.count);
      } else lect[sid] = next;
    }
    return { lines, lect };
  }

  /** `read("L2")` / `read("L2@10:00")`: transcript and crops interleaved by time. */
  private async readLecture(label: string, from: number): Promise<AgentResult> {
    this.requireLectureLive();
    const sid = resolveLecture(this.lectureLabels(), label);
    if (!sid || !this.lectures()[sid]) throw new Error(`No lecture ${label}; read("outline") lists them`);
    const docId = lecDocId(this.notebookId, sid);
    const d = await room(this.env, docId).lectureData(docId);
    this.requireLectureLive();
    // A session that went silent while live (crashed app, closed tab) reads as stopped.
    if (this.lectures()[sid]?.expired) d.meta = { ...d.meta, state: 'stopped' };
    const parts = encodeLectureRead(label, d.meta, d.transcript, d.crops as LectureCrop[], from);
    const text = parts.flatMap((p) => ('text' in p ? [p.text] : [])).join('\n');
    return { text, svg: null, changed: false, parts };
  }

  /** Outline lines for the notebook's sessions (`L2 2026-11-24 47:10 stopped`). */
  private lectureOutline(): string[] {
    if (!this.lectureLive()) return [];
    const labels = this.lectureLabels();
    return Object.entries(this.lectures())
      .sort((a, b) => a[1].startedAt - b[1].startedAt)
      .flatMap(([sid, l]) => {
        const label = labels.byId[sid];
        if (!label) return [];
        const meta: LectureMeta = { id: sid, notebookId: this.notebookId, startedAt: l.startedAt, durationMs: l.durationMs, state: l.expired ? 'stopped' : l.state, lastT: l.lastT, transcriber: 'none', ...(l.title ? { title: l.title } : {}) };
        return [lectureLine(label, meta)];
      });
  }

  /**
   * Long-polls for the next update (qink-live.md §1): resolves when the pen has been idle for `idleMs`, something
   * changed since the last delivery and `minIntervalMs` passed since the last wake, or at once on a new ask.
   */
  async wait(who: AgentWho, session: string, cfg: AgentConfig): Promise<AgentResult> {
    const { clientId } = who;
    const deadline = Date.now() + cfg.timeoutMs;
    if (!this.r.kvGet(agentKey(clientId))) this.r.kvPut(agentKey(clientId), this.state(clientId));
    this.touch(who);
    this.waiting.set(clientId, (this.waiting.get(clientId) ?? 0) + 1);
    // Only a delivered update counts as a call when the wait ends. A wait that times out doesn't: an agent that
    // went away mid-wait (its wait runs on here until the timeout) drops out a minute after it started that wait.
    let delivered = false;
    // A wait that starts paused parks until Play (or its timeout); one that was live and pauses ends at once as "paused".
    let wasLive = this.isLive();
    const paused = { text: `#q s=${session} paused`, svg: null, changed: false };
    try {
      for (;;) {
        const r = await this.tryDeliver(clientId, session, cfg);
        if ('text' in r) {
          delivered = r.changed;
          return r;
        }
        const until = this.isLive() ? this.r.liveUntil() : 0;
        if (until) wasLive = true;
        else if (wasLive) return paused;
        const t = Date.now();
        if (t >= deadline) return until ? { text: `#q s=${session} no changes`, svg: null, changed: false } : paused;
        // Re-check when the heartbeat would lapse, so a device that went silent pauses the wait too.
        await this.sleep(Math.min(r.retryAt, deadline, until || Infinity) - t);
      }
    } finally {
      const n = (this.waiting.get(clientId) ?? 1) - 1;
      if (n > 0) this.waiting.set(clientId, n);
      else this.waiting.delete(clientId);
      if (delivered) this.touch(who);
    }
  }

  private async tryDeliver(clientId: string, session: string, cfg: AgentConfig): Promise<AgentResult | { retryAt: number }> {
    // Checked on every pass: turning AI access off ends a wait at once (meta changes wake waiters).
    // While paused nothing goes out (ink, asks, comments and replies wait); Play wakes the wait and the next update
    // catches up on everything since the last one.
    if (!this.aiAccess()) throw new Error(AI_OFF);
    if (!this.isLive()) return { retryAt: Infinity };
    const st = this.state(clientId);
    const nb = this.nb();
    const allAsks = nb.asks();
    // Asks are client-written: a malformed one is logged and skipped (askCount still moves past it below).
    const asks = allAsks.slice(st.askCount).flatMap((a, i) => {
      const c = cleanAsk(a, (why) => console.warn(`qalm agent: notebook ${this.notebookId} ask #${st.askCount + i}: ${why}`));
      return c ? [c] : [];
    }) satisfies QinkAsk[];
    const live = new Set(nb.pages().map((p) => p.id));
    const changedIds = Object.entries(this.changed)
      .filter(([id, at]) => at > st.deliveredAt && live.has(id))
      .map(([id]) => id);
    const t0 = Date.now();
    // A new ask, comment or reply goes out at once; ink waits for a pause (and the rate limit).
    const urgent = asks.length > 0 || (this.r.kvGet<number>('lastCommentAt') ?? 0) > st.deliveredAt;
    const talk = this.hasTranscriptNews(st);
    if (!urgent) {
      if (!changedIds.length && !talk) return { retryAt: Infinity };
      // Ink waits for the pen to rest; transcript lines alone only for the rate limit (the teacher keeps talking).
      const ready = changedIds.length ? Math.max(this.lastClientUpdateAt() + cfg.idleMs, st.lastWakeAt + cfg.minIntervalMs) : st.lastWakeAt + cfg.minIntervalMs;
      if (t0 < ready) return { retryAt: ready };
    }

    const pages = await this.loadPages([...changedIds, ...asks.map((a) => a.pageId).filter((id) => live.has(id))]);
    // Transcript lines are fetched here, before the synchronous read-encode-write of regions and threads below: an
    // await (a call to another room) inside that section would let a concurrent call allocate R/C labels that the
    // kvPut below then overwrites.
    const news = this.lectureLive() ? await this.transcriptNews(st) : { lines: [], lect: st.lect ?? {} };
    // Every await is behind us: re-check access, sharing and the lecture gate, then that nobody delivered meanwhile.
    if (!this.aiAccess()) throw new Error(AI_OFF);
    // Not live any more (Pause, AI off, a device's heartbeat lapsed) after the awaits: nothing goes out, lecture lines
    // included (lectureLive() is isLive()); nothing is saved, so it all goes with the next update after Play.
    if (!this.isLive() || (news.lines.length && !this.lectureLive())) return { retryAt: Infinity };
    const cur = this.state(clientId);
    if (cur.rev !== st.rev || cur.askCount !== st.askCount) return { retryAt: 0 };
    // From here to the kvPuts: no await.
    const regions = this.regions();
    const threads = this.threads();
    const prev: Record<string, InkSeen | undefined> = {};
    for (const id of Object.keys(pages)) prev[id] = this.r.kvGet<InkSeen>(inkKey(clientId, id));
    const u = encodeQinkUpdate(nb, pages, regions, prev, { session, rev: st.rev + 1, client: clientId, asks, threads, seen: st.seen });
    if (news.lines.length) u.text = `${u.text}\n${news.lines.join('\n')}`;
    this.r.kvPut('regions', regions);
    this.r.kvPut('threads', threads);
    for (const [id, ink] of Object.entries(u.ink)) this.r.kvPut(inkKey(clientId, id), ink);
    // States saved before regions carry a line snapshot: drop it (pages without ink seen get a first look).
    const { snapshot: _old, ...rest } = st as AgentState & { snapshot?: unknown };
    const next: AgentState = { ...rest, seen: u.seen, deliveredAt: t0, askCount: allAsks.length, lect: news.lect };
    // Nothing the agent can see changed (e.g. only a comment was added): absorb it and keep waiting.
    if (!asks.length && !u.text.includes('\n')) {
      this.r.kvPut(agentKey(clientId), next);
      return { retryAt: Infinity };
    }
    next.rev = st.rev + 1;
    next.lastWakeAt = Date.now();
    this.r.kvPut(agentKey(clientId), next);
    return { text: u.text, svg: this.imageSvg(pages, u.image), changed: true };
  }

  /** `outline`, a page `p3`, a region `R7`, a box `p3@120,300,260,80`, `pdf:p2`, or a whole thread `C5`. */
  async read(ref: string, who: AgentWho): Promise<AgentResult> {
    this.touch(who);
    this.requireLive();
    const nb = this.nb();
    const r0 = ref.trim();
    const lecture = parseLectureRef(r0);
    if (lecture) return this.readLecture(lecture.label, lecture.from);
    if (/^c\d+$/i.test(r0)) {
      const threads = this.threads();
      const pages = await this.loadPages([resolveThread(threads, r0).pageId].filter((id) => nb.pages().some((p) => p.id === id)));
      this.requireLive();
      return { text: encodeQinkThread(nb, pages, threads, r0), svg: null, changed: false };
    }
    let ids: string[] = [];
    if (r0 === 'outline') ids = nb.pages().map((p) => p.id);
    else if (!/^pdf:/i.test(r0)) ids = [resolveTarget(nb, this.regions(), r0).pageId];
    const pages = await this.loadPages(ids);
    this.requireLive();
    const regions = this.regions();
    const r = encodeQinkRead(nb, pages, regions, r0, who.clientId);
    this.r.kvPut('regions', regions);
    const text = r0 === 'outline' ? [r.text, ...this.lectureOutline()].join('\n') : r.text;
    return { text, svg: this.imageSvg(pages, r.image), changed: false };
  }

  async edit(edit: AgentEdit, who: AgentWho): Promise<string> {
    this.touch(who);
    this.requireLive();
    if (edit.op === 'comment' && edit.thread) {
      const ref = edit.thread.trim().toUpperCase();
      const { pageId, commentId } = resolveThread(this.threads(), ref);
      if (!this.nb().pages().some((p) => p.id === pageId)) throw new Error(`Thread ${ref} was on a deleted page`);
      return this.applyOn(pageId, { op: 'reply', ref, text: edit.text, agentName: edit.agentName, commentId, resolve: edit.resolve });
    }
    if (!edit.ref) throw new Error('Pass ref (a region "R7", a box "p3@120,300,260,80" or a page "p3") or thread (e.g. "C3")');
    const t = resolveTarget(this.nb(), this.regions(), edit.ref);
    const ref = t.kind === 'region' ? t.label : edit.ref.trim();
    const where = t.kind === 'region' ? { ids: t.ids, box: t.box } : t.kind === 'box' ? { box: t.box } : {};
    if (edit.op === 'transcribe') {
      if (t.kind === 'page') throw new Error('transcribe needs a region ("R7") or a box ("p3@120,300,260,80"), not a whole page');
      return this.applyOn(t.pageId, { op: 'transcribe', ref, text: edit.text, agentName: who.name, ...where });
    }
    return this.applyOn(t.pageId, { op: 'comment', ref, text: edit.text, agentName: edit.agentName, ...where });
  }

  /** Runs an edit in the page's room. A new thread gets its label here (only this room assigns labels). */
  private async applyOn(pageId: string, edit: PageEdit): Promise<string> {
    const docId = pgDocId(this.notebookId, pageId);
    // The page room asks this room again right before it writes, so nothing lands once the student paused.
    const r = await room(this.env, docId).applyAgentEdit(docId, edit, nbDocId(this.notebookId));
    if (!r.ok) throw new Error(r.text);
    // The app's notebook-wide comments list and unread badge read the thread index, not every page.
    if (r.threads?.length) this.r.putThreads(r.threads);
    if (!r.id) return r.text;
    const threads = this.threads();
    const label = threadLabel(threads, r.id, pageId);
    this.r.kvPut('threads', threads);
    return `${r.text} as thread ${label}`;
  }
}
