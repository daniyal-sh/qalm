import type { Comment } from '@qalm/core';

import type { PageData } from './context';

export type CommentFilter = 'open' | 'ai' | 'resolved';

export interface CommentRow {
  pageId: string;
  data: PageData;
  comment: Comment;
}

/** Open / AI / resolved comments ('all': every thread), page order then newest first. */
export function commentRows(pages: Map<string, PageData>, filter: CommentFilter | 'all'): CommentRow[] {
  const out: CommentRow[] = [];
  for (const [pageId, data] of pages) {
    for (const comment of data.comments) {
      if (filter !== 'all' && (filter === 'resolved' ? !comment.resolved : comment.resolved)) continue;
      if (filter === 'ai' && comment.author.kind !== 'agent') continue;
      out.push({ pageId, data, comment });
    }
  }
  return out.sort((a, b) => a.data.index - b.data.index || b.comment.createdAt - a.comment.createdAt);
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
