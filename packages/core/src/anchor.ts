import { itemBBox, unionBBox } from './geometry/bbox';
import type { BBox, Comment, Item, Line } from './types';

/**
 * Where a thread sits, derived live from the page (so a thread on a selection follows its ink when it is moved):
 * - a thread on a selection with `anchorIds`: the box of those items still on the page, or null once they are all gone;
 * - an older selection thread (box only): its stored `anchor` box;
 * - a thread on a line: the line's box, or null once the line is gone.
 */
export function threadBox(c: Comment, items: readonly Item[], lines: readonly Line[]): BBox | null {
  if (c.anchorIds?.length) {
    const ids = new Set(c.anchorIds);
    let box: BBox | null = null;
    for (const it of items) if (ids.has(it.id)) box = unionBBox(box, itemBBox(it));
    return box;
  }
  if (c.anchor) return c.anchor;
  return lines.find((l) => l.key === c.lineKey)?.bbox ?? null;
}

/** A thread on a selection whose anchored ink has all been deleted (show it unanchored, "ink removed"). */
export function anchorInkRemoved(c: Comment, items: readonly Item[]): boolean {
  if (!c.anchorIds?.length) return false;
  const ids = new Set(c.anchorIds);
  return !items.some((it) => ids.has(it.id));
}

/** The lines a selection thread is about, live: those holding any of its anchored items (in `lines` order). */
export function anchorLines(c: Comment, lines: readonly Line[]): Line[] {
  const ids = new Set(c.anchorIds ?? []);
  return lines.filter((l) => l.itemIds.some((id) => ids.has(id)));
}
