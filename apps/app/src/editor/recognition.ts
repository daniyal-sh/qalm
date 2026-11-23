import type { InkPoint, Line, Page } from '@qalm/core';
import type * as Y from 'yjs';

export interface RecognizeLine {
  key: string;
  strokes: InkPoint[][];
}
export interface RecognizeResult {
  key: string;
  text: string;
  score: number;
}
export type RecognizeFn = (lines: RecognizeLine[], lang: 'en-US') => Promise<RecognizeResult[]>;

/**
 * Origin for recognition writes. Wrapping `setLineText` in a transaction with this origin keeps
 * device guesses out of the page's UndoManager (which tracks only LOCAL_ORIGIN), so undo never
 * "undoes" a recognition result.
 */
export const RECOGNITION_ORIGIN = Symbol('qalm.recognition');

interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(h: unknown): void;
}
const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** What identifies a line's content: its items and their extent. */
export function lineSignature(l: Line): string {
  return `${l.itemIds.join(',')}|${l.bbox.map((v) => Math.round(v * 10)).join(',')}`;
}

export interface RecognitionOptions {
  delayMs?: number;
  timers?: Timers;
  lang?: 'en-US';
}

/**
 * Debounced on-device recognition (tech-spec §5): 1 s after a line last changed locally, its strokes
 * go to `recognize`, and each result is saved with `setLineText(key, text, 'device', score)`.
 * Empty results (web/desktop resolve []) are skipped. Lines whose text came from an agent or the
 * user are left alone, and results for lines that changed meanwhile are dropped.
 */
export class RecognitionScheduler {
  private readonly delayMs: number;
  private readonly timers: Timers;
  private pending = new Map<string, { sig: string; handle: unknown }>();
  /** Last signature each line was recognized at (or attempted). */
  private done = new Map<string, string>();
  private off: (() => void) | null = null;
  private inflight = 0;
  private idleWaiters: (() => void)[] = [];

  constructor(
    private readonly page: Page,
    private readonly recognize: RecognizeFn,
    opts: RecognitionOptions = {},
  ) {
    this.delayMs = opts.delayMs ?? 1000;
    this.timers = opts.timers ?? realTimers;
    // Lines that already exist are not re-recognized on open.
    for (const l of page.lines()) this.done.set(l.key, lineSignature(l));
  }

  start(): () => void {
    this.off ??= this.page.observe((tx: Y.Transaction) => {
      if (!tx.local || tx.origin === RECOGNITION_ORIGIN) return;
      this.scan();
    });
    return () => this.stop();
  }

  stop(): void {
    this.off?.();
    this.off = null;
    for (const p of this.pending.values()) this.timers.clear(p.handle);
    this.pending.clear();
  }

  private scan(): void {
    const lines = this.page.lines();
    const live = new Set<string>();
    for (const l of lines) {
      live.add(l.key);
      if (l.kind !== 'line') continue;
      if (l.textSrc === 'agent' || l.textSrc === 'user') continue;
      const sig = lineSignature(l);
      if (this.done.get(l.key) === sig) continue;
      const p = this.pending.get(l.key);
      if (p) this.timers.clear(p.handle);
      const handle = this.timers.set(() => this.fire(l.key), this.delayMs);
      this.pending.set(l.key, { sig, handle });
    }
    for (const [key, p] of this.pending) {
      if (!live.has(key)) {
        this.timers.clear(p.handle);
        this.pending.delete(key);
      }
    }
  }

  private fire(key: string): void {
    const p = this.pending.get(key);
    if (!p) return;
    this.pending.delete(key);
    const line = this.page.lines().find((l) => l.key === key);
    if (!line || lineSignature(line) !== p.sig) return;
    if (line.textSrc === 'agent' || line.textSrc === 'user') return;
    const strokes: InkPoint[][] = [];
    for (const id of line.itemIds) {
      const it = this.page.item(id);
      if (it?.type === 'stroke' && it.tool === 'pen') strokes.push(it.points);
    }
    this.done.set(key, p.sig);
    if (strokes.length === 0) return;
    this.inflight++;
    void this.recognize([{ key, strokes }], 'en-US')
      .then((results) => {
        for (const r of results) {
          if (!r.text) continue;
          const now = this.page.lines().find((l) => l.key === r.key);
          if (!now || lineSignature(now) !== p.sig) continue;
          this.page.doc.transact(() => this.page.setLineText(r.key, r.text, 'device', r.score), RECOGNITION_ORIGIN);
        }
      })
      .catch(() => {
        // Recognizer unavailable (model not downloaded yet, etc.): allow a retry on the next change.
        this.done.delete(key);
      })
      .finally(() => {
        this.inflight--;
        if (this.inflight === 0) for (const w of this.idleWaiters.splice(0)) w();
      });
  }

  /** Resolves when no recognition call is in flight (tests). */
  idle(): Promise<void> {
    if (this.inflight === 0) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }
}
