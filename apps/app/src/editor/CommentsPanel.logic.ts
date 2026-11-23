import type { Comment } from '@qalm/core';

import type { PageData } from './context';

export type CommentFilter = 'open' | 'ai' | 'resolved';

export interface CommentRow {
  pageId: string;
  data: PageData;
  comment: Comment;
}

/** Open / AI / resolved comments, page order then newest first. */
export function commentRows(pages: Map<string, PageData>, filter: CommentFilter): CommentRow[] {
  const out: CommentRow[] = [];
  for (const [pageId, data] of pages) {
    for (const comment of data.comments) {
      if (filter === 'resolved' ? !comment.resolved : comment.resolved) continue;
      if (filter === 'ai' && comment.author.kind !== 'agent') continue;
      out.push({ pageId, data, comment });
    }
  }
  return out.sort((a, b) => a.data.index - b.data.index || b.comment.createdAt - a.comment.createdAt);
}

