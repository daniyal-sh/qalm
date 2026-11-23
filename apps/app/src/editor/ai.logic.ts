import { agentEntriesAfter, threadBox as coreThreadBox, type BBox, type Comment, type Item, type ThreadSummary } from '@qalm/core';

/** Per notebook, on this device: comment id -> thread entries (comment + replies) the student has seen. */
export type SeenThreads = Record<string, number>;

/** What read state needs from a thread: its id and who wrote each entry (a `ThreadSummary`). */
export type ThreadEntries = Pick<ThreadSummary, 'id' | 'kinds'>;

/** Agent-written entries (comments and replies) across these threads. */
export function agentEntryCount(threads: Iterable<ThreadEntries>): number {
  let n = 0;
  for (const t of threads) n += agentEntriesAfter(t);
  return n;
}

/** The latest agent comment or reply (by its timestamp), notebook-wide. */
export function newestAgentEntry(threads: Iterable<ThreadSummary>): { at: number; name: string; id: string; pageId: string } | null {
  let best: { at: number; name: string; id: string; pageId: string } | null = null;
  for (const t of threads) if (t.lastAgent && (!best || t.lastAgent.at > best.at)) best = { ...t.lastAgent, id: t.id, pageId: t.pageId };
  return best;
}

/** Agent entries in thread `t` the student hasn't seen yet. */
export function unreadIn(t: ThreadEntries, seen: SeenThreads): number {
  return agentEntriesAfter(t, seen[t.id] ?? 0);
}

export function unreadCount(threads: Iterable<ThreadEntries>, seen: SeenThreads): number {
  let n = 0;
  for (const t of threads) n += unreadIn(t, seen);
  return n;
}

/** `seen` with these threads marked as read up to their latest entry (the same object if nothing changed). */
export function markSeen(threads: Iterable<ThreadEntries>, seen: SeenThreads): SeenThreads {
  let out = seen;
  for (const t of threads) {
    const n = t.kinds.length;
    if ((out[t.id] ?? 0) >= n) continue;
    if (out === seen) out = { ...seen };
    out[t.id] = n;
  }
  return out;
}

/** Ids of the threads with unread agent entries. */
export function unreadIds(threads: Iterable<ThreadEntries>, seen: SeenThreads): Set<string> {
  const out = new Set<string>();
  for (const t of threads) if (unreadIn(t, seen) > 0) out.add(t.id);
  return out;
}

/**
 * Where a thread sits on its page, live: a selection thread follows its items (null once they are all deleted),
 * an older one keeps its stored box, a line thread sits at its line.
 */
export function threadBox(c: Comment, items: readonly Item[] = []): BBox | null {
  return coreThreadBox(c, items);
}

export interface MarginCard {
  comment: Comment;
  /** px from the top of the page */
  top: number;
}

/**
 * Open threads for the page margin, top to bottom next to their ink, pushed down so they never overlap
 * (`height` px each plus `gap`). With `pageH` (px), cards that would run past the page's bottom are pulled back up
 * (when they all fit), so they don't spill onto the next page's cards. Threads whose ink is gone (or on the whole page) are left to the panel.
 */
export function marginCards(
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
    .map((c) => ({ c, box: threadBox(c, items) }))
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
  /** Every thread when the Ask was sent: comment id -> agent entries in it. */
  before: Record<string, number>;
  at: number;
  /** The thread the answer goes in (an Ask about a selection); its margin card shows "Thinking…". */
  commentId?: string;
}

/** Snapshot of the notebook's threads when an Ask is sent. */
export function startThinking(threads: Iterable<ThreadEntries>, at: number, commentId?: string): Thinking {
  const before: Thinking['before'] = {};
  for (const t of threads) before[t.id] = agentEntriesAfter(t);
  return commentId ? { before, at, commentId } : { before, at };
}

/**
 * Still thinking until an agent writes anywhere in the notebook (a reply, or a new thread), or after THINKING_MS.
 * A thread first seen later but started well before the Ask (an older notebook's index filling in) doesn't count.
 */
export function stillThinking(t: Thinking | null, threads: Iterable<ThreadEntries & Pick<ThreadSummary, 'createdAt'>>, now: number): boolean {
  if (!t || now - t.at >= THINKING_MS) return false;
  for (const x of threads) {
    const was = t.before[x.id];
    if (was === undefined && x.createdAt < t.at - THINKING_MS) continue;
    if (agentEntriesAfter(x) > (was ?? 0)) return false;
  }
  return true;
}
