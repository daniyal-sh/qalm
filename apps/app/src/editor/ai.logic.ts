import type { BBox, Comment, Line } from '@qalm/core';

import type { PageData } from './context';

/** Per notebook, on this device: comment id -> thread entries (comment + replies) the student has seen. */
export type SeenThreads = Record<string, number>;

const entries = (c: Comment) => [{ author: c.author }, ...c.replies];

/** Agent-written entries (comments and replies) across the loaded pages. */
export function agentEntryCount(pages: Iterable<PageData>): number {
  let n = 0;
  for (const d of pages) for (const c of d.comments) n += entries(c).filter((e) => e.author.kind === 'agent').length;
  return n;
}

/** The latest agent comment or reply on the loaded pages (by its timestamp). */
export function newestAgentEntry(pages: Iterable<PageData>): { at: number; name: string } | null {
  let best: { at: number; name: string } | null = null;
  for (const d of pages) {
    for (const c of d.comments) {
      for (const e of [{ author: c.author, at: c.createdAt }, ...c.replies]) {
        if (e.author.kind === 'agent' && (!best || e.at > best.at)) best = { at: e.at, name: e.author.name };
      }
    }
  }
  return best;
}

/** Agent entries in `c` the student hasn't seen yet. */
export function unreadIn(c: Comment, seen: SeenThreads): number {
  return entries(c)
    .slice(seen[c.id] ?? 0)
    .filter((e) => e.author.kind === 'agent').length;
}

export function unreadCount(pages: Iterable<PageData>, seen: SeenThreads): number {
  let n = 0;
  for (const d of pages) for (const c of d.comments) n += unreadIn(c, seen);
  return n;
}

/** `seen` with every loaded thread marked as read (the same object if nothing changed). */
export function markAllSeen(pages: Iterable<PageData>, seen: SeenThreads): SeenThreads {
  let out = seen;
  for (const d of pages) {
    for (const c of d.comments) {
      const n = 1 + c.replies.length;
      if ((out[c.id] ?? 0) >= n) continue;
      if (out === seen) out = { ...seen };
      out[c.id] = n;
    }
  }
  return out;
}

/** Where a thread sits on its page: its selection box, else its line's box. */
export function threadBox(c: Comment, lines: Line[]): BBox | null {
  if (c.anchor) return c.anchor;
  return lines.find((l) => l.key === c.lineKey)?.bbox ?? null;
}

export interface MarginCard {
  comment: Comment;
  /** px from the top of the page */
  top: number;
}

/**
 * Open threads for the page margin, top to bottom next to their line, pushed down so they never overlap
 * (`height` px each plus `gap`). Threads whose line is gone are left to the panel.
 */
export function marginCards(lines: Line[], comments: Comment[], scale: number, height: number, gap = 8, activeId: string | null = null): MarginCard[] {
  const placed = comments
    .filter((c) => !c.resolved || c.id === activeId)
    .map((c) => ({ c, box: threadBox(c, lines) }))
    .filter((x): x is { c: Comment; box: BBox } => x.box !== null)
    .sort((a, b) => a.box[1] - b.box[1] || a.c.createdAt - b.c.createdAt);
  const out: MarginCard[] = [];
  let next = 0;
  for (const { c, box } of placed) {
    const top = Math.max(box[1] * scale - 4, next);
    out.push({ comment: c, top });
    next = top + height + gap;
  }
  return out;
}

/** After an Ask: the agent is "thinking" until a new agent entry arrives, or this long has passed. */
export const THINKING_MS = 90_000;

export interface Thinking {
  /** agentEntryCount when the Ask was sent */
  baseline: number;
  at: number;
}

export function stillThinking(t: Thinking | null, agentEntries: number, now: number): boolean {
  return !!t && agentEntries <= t.baseline && now - t.at < THINKING_MS;
}
