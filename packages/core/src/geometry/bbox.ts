import { wrapText } from '../render/text';
import { layoutMarkdown, rendersMarkdown } from '../markdown/layout';
import { TEXT_CHAR_WIDTH, TEXT_LINE_HEIGHT } from './textConstants';
import type { BBox, ImageItem, Item, TextItem } from '../types';

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

export { TEXT_LINE_HEIGHT, TEXT_CHAR_WIDTH };

/** Rows a text box wraps into at its width (estimated). */
export function textRows(item: Pick<TextItem, 'text' | 'w' | 'fontSize'>): number {
  return Math.max(1, wrapText(item.text, item.w, (s) => s.length * item.fontSize * TEXT_CHAR_WIDTH).length);
}

/** Measures the laid-out height of a text box with the real font; null when it can't (fonts not loaded yet). */
export type TextMeasure = (item: Pick<TextItem, 'text' | 'w' | 'fontSize'>) => number | null;
let measure: TextMeasure | null = null;

/**
 * Installs the renderer's text measure (the app's PageCanvas registers Skia's, with the font it draws), so text
 * boxes' heights, frames and hit boxes fit the drawn text. Without one (server, tests) heights are estimated.
 */
export function setTextMeasure(fn: TextMeasure | null): void {
  measure = fn;
}

/**
 * Height of a text box. A Markdown box (`format: 'md'`) is as tall as its layout (the same everywhere); a plain one is
 * measured when a measure is installed, else estimated from an average glyph width.
 */
export function textHeight(item: Pick<TextItem, 'text' | 'w' | 'fontSize' | 'format'>): number {
  const row = item.fontSize * TEXT_LINE_HEIGHT;
  if (rendersMarkdown(item)) return Math.max(row, layoutMarkdown(item.text, item.w, item.fontSize).height);
  const h = measure?.(item);
  if (h != null && Number.isFinite(h)) return Math.max(row, h);
  return textRows(item) * row;
}

/** The 4 corners (top-left, top-right, bottom-right, bottom-left) of a text box or image, turned by `rot` about (x, y). */
export function boxCorners(item: TextItem | ImageItem): [number, number][] {
  const h = item.type === 'text' ? textHeight(item) : item.h;
  const r = item.rot ?? 0;
  const c = Math.cos(r), s = Math.sin(r);
  return ([[0, 0], [item.w, 0], [item.w, h], [0, h]] as const).map(([u, v]) => [item.x + u * c - v * s, item.y + u * s + v * c]);
}

export function itemBBox(item: Item): BBox {
  switch (item.type) {
    case 'stroke':
      return item.bbox;
    case 'shape': {
      if (item.kind === 'ellipse' && item.pts.length >= 4) {
        // Exact extent of a rotated ellipse: centre ± (|u|, |v|) per axis.
        const [p0, p1, p2, p3] = item.pts as [number, number][];
        const cx = (p0![0] + p2![0]) / 2, cy = (p0![1] + p2![1]) / 2;
        const ux = (p1![0] - p0![0]) / 2, uy = (p1![1] - p0![1]) / 2, vx = (p3![0] - p0![0]) / 2, vy = (p3![1] - p0![1]) / 2;
        const ex = Math.hypot(ux, vx) + item.width / 2, ey = Math.hypot(uy, vy) + item.width / 2;
        return [cx - ex, cy - ey, cx + ex, cy + ey];
      }
      return pointsBBox(item.pts.map(([x, y]) => ({ x, y })), item.width / 2);
    }
    case 'image':
    case 'text':
      if (!item.rot) return [item.x, item.y, item.x + item.w, item.y + (item.type === 'text' ? textHeight(item) : item.h)];
      return pointsBBox(boxCorners(item).map(([x, y]) => ({ x, y })));
  }
}
