import { newIdFallback } from '../lib/id';
import type { BBox, InkPoint, Item, PenStyle, ShapeItem, Smoothing, StrokeItem, TextItem } from '@qalm/core';

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

export function itemBBox(it: Item): BBox {
  switch (it.type) {
    case 'stroke':
      return it.bbox;
    case 'image':
      return [it.x, it.y, it.x + it.w, it.y + it.h];
    case 'text': {
      const lines = Math.max(1, it.text.split('\n').length);
      return [it.x, it.y, it.x + it.w, it.y + it.fontSize * TEXT_LINE_HEIGHT * lines];
    }
    case 'shape': {
      const r = it.width / 2;
      return pointsBBox(it.pts.map(([x, y]) => ({ x, y })), r);
    }
  }
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

/** A move + scale about an origin: p' = o + (p - o) * s + d. */
export interface Xform {
  dx: number;
  dy: number;
  s: number;
  ox: number;
  oy: number;
}

export const IDENTITY: Xform = { dx: 0, dy: 0, s: 1, ox: 0, oy: 0 };

const tx = (x: number, f: Xform) => f.ox + (x - f.ox) * f.s + f.dx;
const ty = (y: number, f: Xform) => f.oy + (y - f.oy) * f.s + f.dy;

/** The transformed item (same id). Stroke widths and text sizes scale with the selection. */
export function transformItem(it: Item, f: Xform): Item {
  switch (it.type) {
    case 'stroke': {
      const points = it.points.map((p) => ({ ...p, x: tx(p.x, f), y: ty(p.y, f) }));
      const width = it.width * f.s;
      return { ...it, points, width, bbox: pointsBBox(points, width / 2) };
    }
    case 'shape':
      return { ...it, pts: it.pts.map(([x, y]) => [tx(x, f), ty(y, f)] as [number, number]), width: it.width * f.s };
    case 'text':
      return { ...it, x: tx(it.x, f), y: ty(it.y, f), w: it.w * f.s, fontSize: it.fontSize * f.s };
    case 'image':
      return { ...it, x: tx(it.x, f), y: ty(it.y, f), w: it.w * f.s, h: it.h * f.s };
  }
}

/** The fields to write back for a transformed item (Page.updateItem patch). */
export function transformPatch(it: Item, f: Xform): Partial<Item> {
  const t = transformItem(it, f);
  switch (t.type) {
    case 'stroke':
      return { points: t.points, width: t.width, bbox: t.bbox } as Partial<StrokeItem>;
    case 'shape':
      return { pts: t.pts, width: t.width } as Partial<ShapeItem>;
    case 'text':
      return { x: t.x, y: t.y, w: t.w, fontSize: t.fontSize } as Partial<TextItem>;
    case 'image':
      return { x: t.x, y: t.y, w: t.w, h: t.h };
  }
}

/** Recolours strokes, shapes and text. Images keep their pixels. */
export function recolorPatch(it: Item, color: string): Partial<Item> | null {
  return it.type === 'image' ? null : ({ color } as Partial<Item>);
}

/** Copies of items with fresh ids, offset by (dx, dy). */
export function cloneItems(items: Item[], dx: number, dy: number, newId: () => string = newIdFallback): Item[] {
  return items.map((it) => ({ ...transformItem(it, { dx, dy, s: 1, ox: 0, oy: 0 }), id: newId() }) as Item);
}

export function hitText(items: Item[], x: number, y: number): TextItem | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.type !== 'text') continue;
    const [x0, y0, x1, y1] = itemBBox(it);
    if (x >= x0 && x <= x1 && y >= y0 && y <= y1) return it;
  }
  return null;
}
