import type { BBox, Item } from '../types';

export function unionBBox(a: BBox | null, b: BBox): BBox {
  if (!a) return [b[0], b[1], b[2], b[3]];
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

export function intersects(a: BBox, b: BBox): boolean {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

export function pointsBBox(pts: readonly { x: number; y: number }[], pad = 0): BBox {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const q of pts) {
    if (q.x < x0) x0 = q.x;
    if (q.y < y0) y0 = q.y;
    if (q.x > x1) x1 = q.x;
    if (q.y > y1) y1 = q.y;
  }
  if (x0 === Infinity) return [0, 0, 0, 0];
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
}

/** Line height of typed text boxes, as a multiple of the font size. */
export const TEXT_LINE_HEIGHT = 1.3;

export function itemBBox(item: Item): BBox {
  switch (item.type) {
    case 'stroke':
      return item.bbox;
    case 'shape':
      return pointsBBox(item.pts.map(([x, y]) => ({ x, y })), item.width / 2);
    case 'image':
      return [item.x, item.y, item.x + item.w, item.y + item.h];
    case 'text': {
      const rows = Math.max(1, item.text.split('\n').length);
      return [item.x, item.y, item.x + item.w, item.y + rows * item.fontSize * TEXT_LINE_HEIGHT];
    }
  }
}
