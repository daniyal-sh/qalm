import * as Y from 'yjs';
import { Notebook, Page, encodeQinkUpdate, encodeQinkRead, resolveRef, renderLinesStripSvg, type QinkLabels, type QinkSnapshot, type QinkImage } from '@qalm/core';
import type { Env } from './env';
import { pgDocId, room } from './docs';
import type { DocRoom } from './room';

export interface AgentConfig { idleMs: number; minIntervalMs: number; timeoutMs: number }
/** Q-ink text plus, when lines need one, the strip image as SVG (the worker turns it into PNG). */
export interface AgentResult { text: string; svg: string | null; changed: boolean; error?: boolean }
export type AgentEdit =
  | { op: 'transcribe'; ref: string; text: string }
  | { op: 'comment'; ref: string; text: string; agentName: string };

/** What one agent (OAuth client) has been sent from this notebook. */
interface AgentState {
  snapshot: QinkSnapshot;
  rev: number;
  /** Page changes at or before this time have been delivered. */
  deliveredAt: number;
  lastWakeAt: number;
  /** Number of `asks` entries already delivered. */
  askCount: number;
}

const agentKey = (clientId: string) => `agent:${clientId}`;

export const AI_OFF = 'AI access is off for this notebook. The student can turn it on in the notebook.';

/**
 * Lives in a notebook's DocRoom. Only this object assigns Q-ink labels, so they stay stable and unique.
 * Storage: `labels` (QinkLabels), `changed` (pageId → last client update), `agent:{clientId}` (AgentState).
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

  onPageChanged(pageId: string, at: number): void {
    this.changed[pageId] = Math.max(this.changed[pageId] ?? 0, at);
    this.r.kvPut('changed', this.changed);
    this.r.kvPut('lastClientUpdateAt', Math.max(this.lastClientUpdateAt(), at));
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
    if (!asks.length) {
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
    const u = encodeQinkUpdate(nb, pages, labels, st.snapshot, { session, rev: st.rev + 1, asks });
    this.r.kvPut('labels', labels);
    const next: AgentState = { ...st, snapshot: u.snapshot, deliveredAt: t0, askCount: allAsks.length };
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
    const { pageId, lineKey } = resolveRef(this.labels(), this.nb(), edit.ref);
    const docId = pgDocId(this.notebookId, pageId);
    const r = await room(this.env, docId).applyAgentEdit(docId, { ...edit, lineKey });
    if (!r.ok) throw new Error(r.text);
    return r.text;
  }
}
