import { newIdFallback } from '../lib/id';
import { frameBBox, itemDistance, moveBy, selectionFrame, transformItem, type BBox, type InkPoint, type Item, type PenStyle, type Smoothing, type StrokeItem, type TextItem } from '@qalm/core';

/** Text box line height (matches core's TEXT_LINE_HEIGHT). */
export const TEXT_LINE_HEIGHT = 1.3;
export const DEFAULT_TEXT_SIZE = 16;
export const DEFAULT_TEXT_WIDTH = 260;

export function pointsBBox(points: readonly { x: number; y: number }[], pad = 0): BBox {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of points) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  if (!Number.isFinite(x0)) return [0, 0, 0, 0];
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
}

export function unionBBox(boxes: BBox[]): BBox | null {
  if (!boxes.length) return null;
  let [x0, y0, x1, y1] = boxes[0]!;
  for (const b of boxes) {
    x0 = Math.min(x0, b[0]);
    y0 = Math.min(y0, b[1]);
    x1 = Math.max(x1, b[2]);
    y1 = Math.max(y1, b[3]);
  }
  return [x0, y0, x1, y1];
}

export function makeStroke(e: {
  id: string;
  tool: 'pen' | 'highlighter';
  color: string;
  width: number;
  points: InkPoint[];
  style?: PenStyle;
  smoothing?: Smoothing;
}): StrokeItem {
  return {
    id: e.id,
    type: 'stroke',
    tool: e.tool,
    color: e.color,
    width: e.width,
    points: e.points,
    bbox: pointsBBox(e.points, e.width / 2),
    createdAt: Date.now(),
    // Pen strokes keep the style and smoothing they were drawn with, so later default changes never alter them.
    ...(e.tool === 'pen' ? { style: e.style ?? 'fountain', smoothing: e.smoothing ?? 0 } : null),
  };
}

/** Selection transforms live in core (move, uniform scale and rotation about an origin). */
export { IDENTITY, itemBBox, moveBy, transformItem, transformPatch, type Sim } from '@qalm/core';

/** The page-space box of a selection, with room for the ink (what Ask / Comment on a selection send). */
export function selectionBBox(items: readonly Item[]): BBox | null {
  const f = selectionFrame(items);
  return f ? frameBBox(f) : null;
}

/** Recolours strokes, shapes and text. Images and highlighters keep their colour. */
export function recolorPatch(it: Item, color: string): Partial<Item> | null {
  if (it.type === 'image' || (it.type === 'stroke' && it.tool === 'highlighter')) return null;
  return { color } as Partial<Item>;
}

/** Copies of items with fresh ids, offset by (dx, dy). */
export function cloneItems(items: Item[], dx: number, dy: number, newId: () => string = newIdFallback): Item[] {
  return items.map((it) => ({ ...transformItem(it, moveBy(dx, dy)), id: newId() }) as Item);
}

/** The topmost text box under (x, y), turned ones too. */
export function hitText(items: Item[], x: number, y: number): TextItem | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.type === 'text' && itemDistance(it, [x, y]) === 0) return it;
  }
  return null;
}
