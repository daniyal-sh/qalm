import { threadBox as coreThreadBox, type BBox, type Comment, type Item, type Line } from '@qalm/core';

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

/** `seen` with these threads marked as read up to their latest entry (the same object if nothing changed). */
export function markSeen(threads: Iterable<Comment>, seen: SeenThreads): SeenThreads {
  let out = seen;
  for (const c of threads) {
    const n = 1 + c.replies.length;
    if ((out[c.id] ?? 0) >= n) continue;
    if (out === seen) out = { ...seen };
    out[c.id] = n;
  }
  return out;
}

/** Ids of the threads in `pages` with unread agent entries. */
export function unreadIds(pages: Iterable<PageData>, seen: SeenThreads): Set<string> {
  const out = new Set<string>();
  for (const d of pages) for (const c of d.comments) if (unreadIn(c, seen) > 0) out.add(c.id);
  return out;
}

/**
 * Where a thread sits on its page, live: a selection thread follows its items (null once they are all deleted),
 * an older one keeps its stored box, a line thread sits at its line.
 */
export function threadBox(c: Comment, lines: Line[], items: readonly Item[] = []): BBox | null {
  return coreThreadBox(c, items, lines);
}

export interface MarginCard {
  comment: Comment;
  /** px from the top of the page */
  top: number;
}

/**
 * Open threads for the page margin, top to bottom next to their line, pushed down so they never overlap
 * (`height` px each plus `gap`). With `pageH` (px), cards that would run past the page's bottom are pulled back up
 * (when they all fit), so they don't spill onto the next page's cards. Threads whose line is gone are left to the panel.
 */
export function marginCards(
  lines: Line[],
  comments: Comment[],
  scale: number,
  height: number,
  gap = 8,
  activeId: string | null = null,
  pageH?: number,
  items: readonly Item[] = [],
): MarginCard[] {
  const placed = comments
    .filter((c) => !c.resolved || c.id === activeId)
    .map((c) => ({ c, box: threadBox(c, lines, items) }))
    .filter((x): x is { c: Comment; box: BBox } => x.box !== null)
    .sort((a, b) => a.box[1] - b.box[1] || a.c.createdAt - b.c.createdAt);
  const out: MarginCard[] = [];
  let next = 0;
  for (const { c, box } of placed) {
    const top = Math.max(box[1] * scale - 4, next);
    out.push({ comment: c, top });
    next = top + height + gap;
  }
  if (pageH !== undefined && out.length * (height + gap) - gap <= pageH) {
    let limit = pageH;
    for (let i = out.length - 1; i >= 0 && out[i]!.top + height > limit; i--) {
      out[i]!.top = limit - height;
      limit = out[i]!.top - gap;
    }
  }
  return out;
}

/** After an Ask: the agent is "thinking" until a new agent entry arrives, or this long has passed. */
export const THINKING_MS = 90_000;

export interface Thinking {
  /** Pages loaded when the Ask was sent: page id -> comment id -> agent entries in that thread. */
  before: Record<string, Record<string, number>>;
  at: number;
  /** The thread the answer goes in (an Ask about a selection); its margin card shows "Thinking…". */
  commentId?: string;
}

const agentEntries = (c: Comment) => entries(c).filter((e) => e.author.kind === 'agent').length;

/** Snapshot of the loaded pages (page id -> data) when an Ask is sent. */
export function startThinking(pages: ReadonlyMap<string, PageData>, at: number, commentId?: string): Thinking {
  const before: Thinking['before'] = {};
  for (const [id, d] of pages) before[id] = Object.fromEntries(d.comments.map((c) => [c.id, agentEntries(c)]));
  return commentId ? { before, at, commentId } : { before, at };
}

/**
 * Still thinking until an agent writes on a page that was loaded when the Ask went out (comparing per thread, so
 * pages mounting or unmounting while scrolling neither end it nor keep it going), or after THINKING_MS.
 */
export function stillThinking(t: Thinking | null, pages: ReadonlyMap<string, PageData>, now: number): boolean {
  if (!t || now - t.at >= THINKING_MS) return false;
  for (const [id, d] of pages) {
    const was = t.before[id];
    if (!was) continue;
    for (const c of d.comments) if (agentEntries(c) > (was[c.id] ?? 0)) return false;
  }
  return true;
}
