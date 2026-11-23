import * as Y from 'yjs';
import {
  Notebook,
  Page,
  emptyThreads,
  encodeQinkUpdate,
  encodeQinkRead,
  resolveRef,
  resolveThread,
  renderLinesStripSvg,
  threadLabel,
  type QinkLabels,
  type QinkSnapshot,
  type QinkImage,
  type QinkSeen,
  type QinkThreads,
} from '@qalm/core';
import type { Env } from './env';
import { pgDocId, room } from './docs';
import type { DocRoom } from './room';

export interface AgentConfig { idleMs: number; minIntervalMs: number; timeoutMs: number }
/** Q-ink text plus, when lines need one, the strip image as SVG (the worker turns it into PNG). */
export interface AgentResult { text: string; svg: string | null; changed: boolean; error?: boolean }
export type AgentEdit =
  | { op: 'transcribe'; ref: string; text: string }
  /** A new thread on `ref`, or a reply in `thread` (optionally resolving it). */
  | { op: 'comment'; ref?: string; thread?: string; text: string; agentName: string; resolve?: boolean };
/** What the notebook room asks a page room to do. Agents never touch ink. */
export type PageEdit =
  | { op: 'transcribe'; ref: string; text: string; lineKey: string }
  | { op: 'comment'; ref: string; text: string; agentName: string; lineKey: string }
  | { op: 'reply'; ref: string; text: string; agentName: string; commentId: string; resolve?: boolean };

/** What one agent (OAuth client) has been sent from this notebook. */
interface AgentState {
  snapshot: QinkSnapshot;
  rev: number;
  /** Page changes at or before this time have been delivered. */
  deliveredAt: number;
  lastWakeAt: number;
  /** Number of `asks` entries already delivered. */
  askCount: number;
  /** Thread entries already seen (missing in states saved before threads existed). */
  seen?: QinkSeen;
}

const agentKey = (clientId: string) => `agent:${clientId}`;

export const AI_OFF = 'AI access is off for this notebook. The student can turn it on in the notebook.';

/**
 * Lives in a notebook's DocRoom. Only this object assigns Q-ink labels, so they stay stable and unique.
 * Storage: `labels` (QinkLabels), `threads` (QinkThreads), `changed` (pageId → last client update),
 * `lastCommentAt` (the student's last comment or reply), `agent:{clientId}` (AgentState).
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

  private labels(): QinkLabels {
    return this.r.kvGet<QinkLabels>('labels') ?? {};
  }

  private threads(): QinkThreads {
    return this.r.kvGet<QinkThreads>('threads') ?? emptyThreads();
  }

  /** The notebook's AI access switch, read live from the index doc. Unknown (never synced) counts as off. */
  aiAccess(): boolean {
    return this.nb().meta().aiAccess === true;
  }

  private requireAccess(): void {
    if (!this.aiAccess()) throw new Error(AI_OFF);
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
        out[id] = new Page(doc);
      }),
    );
    return out;
  }

  private stripSvg(pages: Record<string, Page>, image: QinkImage | null): string | null {
    if (!image) return null;
    const page = pages[image.pageId];
    return page ? renderLinesStripSvg(page, image.lineKeys, image.labels).svg : null;
  }

  private state(clientId: string): AgentState {
    const st = this.r.kvGet<AgentState>(agentKey(clientId));
    if (st) return st;
    // A new agent starts now: earlier asks are not replayed, and the first wake is not rate-limited.
    return { snapshot: {}, rev: 0, deliveredAt: Date.now(), lastWakeAt: 0, askCount: this.nb().asks().length };
  }

  /**
   * Long-polls for the next update (qink-live.md §1): resolves when the pen has been idle for `idleMs`, something
   * changed since the last delivery and `minIntervalMs` passed since the last wake, or at once on a new ask.
   */
  async wait(clientId: string, session: string, cfg: AgentConfig): Promise<AgentResult> {
    const deadline = Date.now() + cfg.timeoutMs;
    if (!this.r.kvGet(agentKey(clientId))) this.r.kvPut(agentKey(clientId), this.state(clientId));
    for (;;) {
      const r = await this.tryDeliver(clientId, session, cfg);
      if ('text' in r) return r;
      const t = Date.now();
      if (t >= deadline) return { text: `#q s=${session} no changes`, svg: null, changed: false };
      await this.sleep(Math.min(r.retryAt, deadline) - t);
    }
  }

  private async tryDeliver(clientId: string, session: string, cfg: AgentConfig): Promise<AgentResult | { retryAt: number }> {
    // Checked on every pass: turning AI access off ends a wait at once (meta changes wake waiters).
    this.requireAccess();
    const st = this.state(clientId);
    const nb = this.nb();
    const allAsks = nb.asks();
    const asks = allAsks.slice(st.askCount);
    const live = new Set(nb.pages().map((p) => p.id));
    const changedIds = Object.entries(this.changed)
      .filter(([id, at]) => at > st.deliveredAt && live.has(id))
      .map(([id]) => id);
    const t0 = Date.now();
    // A new ask, comment or reply goes out at once; ink waits for a pause (and the rate limit).
    const urgent = asks.length > 0 || (this.r.kvGet<number>('lastCommentAt') ?? 0) > st.deliveredAt;
    if (!urgent) {
      if (!changedIds.length) return { retryAt: Infinity };
      const ready = Math.max(this.lastClientUpdateAt() + cfg.idleMs, st.lastWakeAt + cfg.minIntervalMs);
      if (t0 < ready) return { retryAt: ready };
    }

    const pages = await this.loadPages([...changedIds, ...asks.map((a) => a.pageId).filter((id) => live.has(id))]);
    this.requireAccess();
    // Re-read after the await: another call may have delivered meanwhile.
    const cur = this.state(clientId);
    if (cur.rev !== st.rev || cur.askCount !== st.askCount) return { retryAt: 0 };
    const labels = this.labels();
    const threads = this.threads();
    const u = encodeQinkUpdate(nb, pages, labels, st.snapshot, { session, rev: st.rev + 1, asks, threads, seen: st.seen });
    this.r.kvPut('labels', labels);
    this.r.kvPut('threads', threads);
    const next: AgentState = { ...st, snapshot: u.snapshot, seen: u.seen, deliveredAt: t0, askCount: allAsks.length };
    // Nothing the agent can see changed (e.g. only a comment was added): absorb it and keep waiting.
    if (!asks.length && !u.text.includes('\n')) {
      this.r.kvPut(agentKey(clientId), next);
      return { retryAt: Infinity };
    }
    next.rev = st.rev + 1;
    next.lastWakeAt = Date.now();
    this.r.kvPut(agentKey(clientId), next);
    return { text: u.text, svg: this.stripSvg(pages, u.image), changed: true };
  }

  /** `outline`, `p3`, `p3:L2-9`, `pdf:p2`. */
  async read(ref: string): Promise<AgentResult> {
    this.requireAccess();
    const nb = this.nb();
    const infos = nb.pages();
    let ids: string[] = [];
    if (ref === 'outline') ids = infos.map((p) => p.id);
    else {
      const m = /^p(\d+)(?::|$)/.exec(ref);
      const info = m ? infos[Number(m[1]) - 1] : undefined;
      if (info) ids = [info.id];
    }
    const pages = await this.loadPages(ids);
    this.requireAccess();
    const labels = this.labels();
    const r = encodeQinkRead(nb, pages, labels, ref);
    this.r.kvPut('labels', labels);
    return { text: r.text, svg: this.stripSvg(pages, r.image), changed: false };
  }

  async edit(edit: AgentEdit): Promise<string> {
    this.requireAccess();
    if (edit.op === 'comment' && edit.thread) {
      const ref = edit.thread.trim().toUpperCase();
      const { pageId, commentId } = resolveThread(this.threads(), ref);
      if (!this.nb().pages().some((p) => p.id === pageId)) throw new Error(`Thread ${ref} was on a deleted page`);
      return this.applyOn(pageId, { op: 'reply', ref, text: edit.text, agentName: edit.agentName, commentId, resolve: edit.resolve });
    }
    if (!edit.ref) throw new Error('Pass ref (a line, e.g. "p3:L4") or thread (e.g. "C3")');
    const { pageId, lineKey } = resolveRef(this.labels(), this.nb(), edit.ref);
    if (edit.op === 'transcribe') return this.applyOn(pageId, { op: 'transcribe', ref: edit.ref, text: edit.text, lineKey });
    return this.applyOn(pageId, { op: 'comment', ref: edit.ref, text: edit.text, agentName: edit.agentName, lineKey });
  }

  /** Runs an edit in the page's room. A new thread gets its label here (only this room assigns labels). */
  private async applyOn(pageId: string, edit: PageEdit): Promise<string> {
    const docId = pgDocId(this.notebookId, pageId);
    const r = await room(this.env, docId).applyAgentEdit(docId, edit);
    if (!r.ok) throw new Error(r.text);
    if (!r.id) return r.text;
    const threads = this.threads();
    const label = threadLabel(threads, r.id, pageId);
    this.r.kvPut('threads', threads);
    return `${r.text} as thread ${label}`;
  }
}
