import type { Item, ShapeItem, StrokeItem } from '@qalm/core';

export type InkItem = StrokeItem | ShapeItem;

/**
 * A slice of the z-order: up to `chunk` consecutive ink items (one recorded picture; `live` when they belong to a
 * selection being dragged, drawn inside its live transform), or one text box or image.
 */
export type Run = { kind: 'ink'; key: string; items: InkItem[]; live: boolean } | { kind: 'item'; item: Exclude<Item, InkItem> };

/** Ink items per recorded picture: adding a stroke re-records only the last chunk, not the whole page. */
export const INK_CHUNK = 256;

/**
 * Splits items (in z-order) into runs: consecutive strokes and shapes are grouped in chunks of at most `chunk`, so z-order
 * against text and images stays exact. A chunk's key is its first item's id. Ink in `live` (a selection being moved,
 * scaled or turned) goes in chunks of its own, so dragging thousands of strokes moves a few pictures, not thousands of nodes.
 */
export function inkRuns(items: readonly Item[], chunk = INK_CHUNK, live?: ReadonlySet<string> | null): Run[] {
  const out: Run[] = [];
  let cur: InkItem[] | null = null;
  let curLive = false;
  for (const it of items) {
    if (it.type === 'stroke' || it.type === 'shape') {
      const isLive = !!live?.has(it.id);
      if (!cur || cur.length >= chunk || isLive !== curLive) {
        cur = [];
        curLive = isLive;
        out.push({ kind: 'ink', key: it.id, items: cur, live: isLive });
      }
      cur.push(it);
    } else {
      cur = null;
      out.push({ kind: 'item', item: it });
    }
  }
  return out;
}

/** Same items, same objects, same order (items keep their identity while unchanged: Page caches reads). */
export function sameItems(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Geometry key of an ink item: its path is rebuilt only when this changes. */
export function inkGeometryKey(it: InkItem): string {
  return it.type === 'stroke'
    ? `s|${it.tool}|${it.width}|${it.style}|${it.smoothing}|${it.points.length}|${it.bbox.join(',')}`
    : `h|${it.kind}|${it.width}|${it.pts.map((p) => p.join(',')).join(';')}`;
}
