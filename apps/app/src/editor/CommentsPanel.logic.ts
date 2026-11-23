import { summarizeThread, type Comment, type ThreadSummary } from '@qalm/core';

import type { PageData } from './context';

export type CommentFilter = 'open' | 'ai' | 'resolved';

/**
 * One thread, notebook-wide. On a loaded page it carries the live comment and page data (and its summary is computed
 * from them); elsewhere only the summary from the notebook's thread index.
 */
export interface CommentRow {
  pageId: string;
  /** The page's position in the notebook. */
  index: number;
  summary: ThreadSummary;
  data?: PageData;
  comment?: Comment;
}

/**
 * Every thread in the notebook, page order then newest first: live from the loaded pages, from the thread index for
 * the rest. Threads on pages no longer in the notebook are left out.
 */
export function threadRows(index: readonly ThreadSummary[], loaded: ReadonlyMap<string, PageData>, pageIds: readonly string[]): CommentRow[] {
  const pos = new Map(pageIds.map((id, i) => [id, i]));
  const out: CommentRow[] = [];
  const live = new Set<string>();
  for (const [pageId, data] of loaded) {
    const i = pos.get(pageId);
    if (i === undefined) continue;
    for (const comment of data.comments) {
      live.add(comment.id);
      out.push({ pageId, index: i, summary: summarizeThread(pageId, comment, data.readings), data, comment });
    }
  }
  for (const t of index) {
    const i = pos.get(t.pageId);
    if (i === undefined || loaded.has(t.pageId) || live.has(t.id)) continue;
    out.push({ pageId: t.pageId, index: i, summary: t });
  }
  return out.sort((a, b) => a.index - b.index || b.summary.createdAt - a.summary.createdAt);
}

/** Open / AI / resolved rows ('all': every row). */
export function filterRows(rows: readonly CommentRow[], filter: CommentFilter | 'all'): CommentRow[] {
  if (filter === 'all') return [...rows];
  return rows.filter((r) => (filter === 'resolved' ? r.summary.resolved : !r.summary.resolved && (filter === 'open' || r.summary.author.kind === 'agent')));
}

/** The tab to show so that thread `c` is listed: `current` if it already lists it. */
export function filterFor(c: Pick<Comment, 'resolved' | 'author'>, current: CommentFilter): CommentFilter {
  if (c.resolved) return 'resolved';
  if (current === 'resolved' || (current === 'ai' && c.author.kind !== 'agent')) return 'open';
  return current;
}

/** A card's box in the panel's scroll content (px). */
export interface RowBox {
  y: number;
  h: number;
}

/** Cards on screen: at least 48 px of them (or all of a shorter one) inside the visible part of the list. */
export function rowsInView(boxes: ReadonlyMap<string, RowBox>, scrollY: number, viewH: number): string[] {
  if (viewH <= 0) return [];
  const out: string[] = [];
  for (const [id, b] of boxes) {
    const shown = Math.min(b.y + b.h, scrollY + viewH) - Math.max(b.y, scrollY);
    if (shown >= Math.min(48, b.h)) out.push(id);
  }
  return out.sort();
}
