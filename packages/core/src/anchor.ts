import { itemBBox, unionBBox } from './geometry/bbox';
import type { BBox, Comment, Item } from './types';

/**
 * Where a thread sits, derived live from the page (so a thread on strokes follows its ink when it is moved):
 * - a thread on strokes (`anchorIds`): the box of those items still on the page, or null once they are all gone;
 * - a thread on a box only: its stored `anchor` box;
 * - a thread on the whole page: null.
 */
export function threadBox(c: Comment, items: readonly Item[]): BBox | null {
  if (c.anchorIds?.length) {
    const ids = new Set(c.anchorIds);
    let box: BBox | null = null;
    for (const it of items) if (ids.has(it.id)) box = unionBBox(box, itemBBox(it));
    return box;
  }
  return c.anchor ?? null;
}

/** A thread on strokes whose ink has all been deleted (show it unanchored, "Ink removed"). */
export function anchorInkRemoved(c: Comment, items: readonly Item[]): boolean {
  if (!c.anchorIds?.length) return false;
  const ids = new Set(c.anchorIds);
  return !items.some((it) => ids.has(it.id));
}
