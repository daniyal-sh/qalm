/** Small editor decisions kept out of EditorScreen so they can be tested. */
import type { LibraryEntry, NotebookMeta } from '@qalm/core';

import type { PageSlot } from './view';

/**
 * Whether the editor can show a notebook. It can't when its index doc is empty (a bogus link, or not synced yet) or
 * when the library has no entry for it (deleted forever, possibly on another device). The editor never creates a
 * library entry: that would put a ghost "Untitled notebook" card back into the library.
 */
export function notebookFound(meta: Pick<NotebookMeta, 'id'> | null, notebookId: string, libraryLoaded: boolean, entry: LibraryEntry | undefined): boolean {
  if (!meta?.id || meta.id !== notebookId) return false;
  return !libraryLoaded || !!entry;
}

/** The library fields mirrored from the notebook's meta (they may change on another device); null when in step. */
export function entryMirror(meta: Pick<NotebookMeta, 'title' | 'cover' | 'aiAccess'>, entry: LibraryEntry): Partial<LibraryEntry> | null {
  if (entry.title === meta.title && entry.cover === meta.cover && entry.aiAccess === meta.aiAccess) return null;
  return { title: meta.title, cover: meta.cover, aiAccess: meta.aiAccess };
}

/**
 * A scroll waiting for the page list to change: bring `pageId` into view once its slot exists. With `offset` (px from
 * the page's top to the scroll position) the view keeps the same spot on that page, e.g. after a reorder.
 */
export interface PendingScroll {
  pageId: string;
  offset?: number;
}

/** Where to scroll for a pending scroll, or null while the page isn't laid out yet. */
export function pendingScrollY(slots: readonly PageSlot[], p: PendingScroll, margin = 80): number | null {
  const slot = slots.find((s) => s.id === p.pageId);
  if (!slot) return null;
  return Math.max(0, p.offset !== undefined ? slot.top + p.offset : slot.top - margin);
}
