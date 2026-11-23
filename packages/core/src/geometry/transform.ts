/**
 * Selection geometry: similarity transforms (move, uniform scale, rotate) of items, the selection frame and its
 * handles, and tap / box hit testing. Pure; the app turns gestures into these.
 */
import { boxCorners, itemBBox, pointsBBox, textHeight, unionBBox } from './bbox';
import { lassoSelect } from './hit';
import { distToSegment, shapePolylines } from './shape';
import type { BBox, Item, ShapeItem, StrokeItem, TextItem } from '../types';

type P = [number, number];

/** p' = o + s·R(r)·(p − o) + d. `r` in radians, clockwise on the page (y points down). */
export interface Sim {
  s: number;
  r: number;
  ox: number;
  oy: number;
  dx: number;
  dy: number;
}

export const IDENTITY: Sim = { s: 1, r: 0, ox: 0, oy: 0, dx: 0, dy: 0 };
export const moveBy = (dx: number, dy: number): Sim => ({ ...IDENTITY, dx, dy });

export function applySim(x: number, y: number, f: Sim): P {
  const c = Math.cos(f.r) * f.s, s = Math.sin(f.r) * f.s;
  const px = x - f.ox, py = y - f.oy;
  return [f.ox + c * px - s * py + f.dx, f.oy + s * px + c * py + f.dy];
}

/** The same transform as a 2D affine matrix `[a, b, c, d, e, f]`: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export function simMatrix(f: Sim): [number, number, number, number, number, number] {
  const a = Math.cos(f.r) * f.s, b = Math.sin(f.r) * f.s;
  return [a, b, -b, a, f.ox + f.dx - (a * f.ox - b * f.oy), f.oy + f.dy - (b * f.ox + a * f.oy)];
}

export const isIdentity = (f: Sim) => f.s === 1 && f.r === 0 && f.dx === 0 && f.dy === 0;

/** Angle in (−π, π]; tiny values become 0 so an unrotated item stays unrotated. */
function normAngle(a: number): number {
  let r = a % (2 * Math.PI);
  if (r > Math.PI) r -= 2 * Math.PI;
  if (r <= -Math.PI) r += 2 * Math.PI;
  return Math.abs(r) < 1e-9 ? 0 : r;
}

/** Corners of a rect or ellipse stored as a 2-point box (older shapes), so it can be rotated. */
function shapeCornerPts(s: ShapeItem): [number, number][] {
  if ((s.kind === 'rect' || s.kind === 'ellipse') && s.pts.length === 2) {
    const [a, b] = [s.pts[0]!, s.pts[1]!];
    return [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]];
  }
  return s.pts;
}

/**
 * The transformed item (same id). Stroke and shape widths and text sizes scale with `s`; text boxes and images
 * turn about their top-left corner.
 */
export function transformItem<T extends Item>(it: T, f: Sim): T {
  switch (it.type) {
    case 'stroke': {
      const points = it.points.map((p) => {
        const [x, y] = applySim(p.x, p.y, f);
        return { ...p, x, y, az: f.r ? normAngle(p.az + f.r) : p.az };
      });
      const width = it.width * f.s;
      return { ...it, points, width, bbox: pointsBBox(points, width / 2) } as T;
    }
    case 'shape':
      return { ...it, pts: shapeCornerPts(it).map(([x, y]) => applySim(x, y, f)), width: it.width * f.s } as T;
    case 'text':
    case 'image': {
      const [x, y] = applySim(it.x, it.y, f);
      const rot = normAngle((it.rot ?? 0) + f.r);
      const out = { ...it, x, y, w: it.w * f.s } as T & { rot?: number };
      if (it.type === 'text') (out as TextItem).fontSize = it.fontSize * f.s;
      else (out as { h: number }).h = it.h * f.s;
      if (rot) out.rot = rot;
      else delete out.rot;
      return out;
    }
  }
  return it;
}

/** The fields to write back for a transformed item (a `Page.updateItem` patch; `rot: undefined` clears it). */
export function transformPatch(it: Item, f: Sim): Partial<Item> {
  const t = transformItem(it, f);
  switch (t.type) {
    case 'stroke':
      return { points: t.points, width: t.width, bbox: t.bbox } as Partial<StrokeItem>;
    case 'shape':
      return { pts: t.pts, width: t.width } as Partial<ShapeItem>;
    case 'text':
      return { x: t.x, y: t.y, w: t.w, fontSize: t.fontSize, rot: t.rot } as Partial<TextItem>;
    case 'image':
      return { x: t.x, y: t.y, w: t.w, h: t.h, rot: t.rot } as Partial<Item>;
  }
}

/**
 * The box an item is drawn in, with room for the ink: brush and fountain strokes can bulge a little past the
 * stored bbox, and arrow heads stick out past their end points.
 */
export function visualBBox(it: Item): BBox {
  if (it.type === 'stroke') {
    const pad = it.width * 0.4 + 0.5; // brush ink reaches ~0.875 × width past its points; the bbox has 0.5
    return [it.bbox[0] - pad, it.bbox[1] - pad, it.bbox[2] + pad, it.bbox[3] + pad];
  }
  if (it.type === 'shape') {
    const pts = shapePolylines(it).flat().map(([x, y]) => ({ x, y }));
    return pts.length ? pointsBBox(pts, it.width / 2 + 0.5) : itemBBox(it);
  }
  return itemBBox(it);
}

/** An oriented box: centre, size and rotation (radians). */
export interface Frame {
  cx: number;
  cy: number;
  w: number;
  h: number;
  rot: number;
}

/**
 * The selection frame: around a single turned text box or image it turns with it; otherwise it is the upright box
 * around everything (after rotating several items it is upright again, like GoodNotes).
 */
export function selectionFrame(items: readonly Item[]): Frame | null {
  if (!items.length) return null;
  const one = items[0]!;
  if (items.length === 1 && (one.type === 'text' || one.type === 'image') && one.rot) {
    const h = one.type === 'text' ? textHeight(one) : one.h;
    const [tl, , br] = boxCorners(one);
    return { cx: (tl![0] + br![0]) / 2, cy: (tl![1] + br![1]) / 2, w: one.w, h, rot: one.rot };
  }
  let box: BBox | null = null;
  for (const it of items) box = unionBBox(box, visualBBox(it));
  const [x0, y0, x1, y1] = box!;
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0, rot: 0 };
}

/** The frame's corners: top-left, top-right, bottom-right, bottom-left (in its own orientation). */
export function frameCorners(f: Frame): P[] {
  const c = Math.cos(f.rot), s = Math.sin(f.rot);
  return ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([u, v]) => {
    const x = (u * f.w) / 2, y = (v * f.h) / 2;
    return [f.cx + x * c - y * s, f.cy + x * s + y * c] as P;
  });
}

/** The frame after a transform. */
export function mapFrame(f: Frame, t: Sim): Frame {
  const [cx, cy] = applySim(f.cx, f.cy, t);
  return { cx, cy, w: f.w * t.s, h: f.h * t.s, rot: normAngle(f.rot + t.r) };
}

/** The upright box around a frame. */
export function frameBBox(f: Frame): BBox {
  return pointsBBox(frameCorners(f).map(([x, y]) => ({ x, y })));
}

/**
 * Uniform scale from dragging corner `corner` (0..3, as `frameCorners`) to `pointer`, about the opposite corner.
 * Keeps aspect ratio (images too); the frame never gets smaller than `minSize` page units.
 */
export function resizeSim(f: Frame, corner: number, pointer: P, minSize = 4): Sim {
  const cs = frameCorners(f);
  const a = cs[(corner + 2) % 4]!;
  const k = cs[corner % 4]!;
  const v0: P = [k[0] - a[0], k[1] - a[1]];
  const len2 = v0[0] * v0[0] + v0[1] * v0[1];
  if (len2 < 1e-9) return IDENTITY;
  const proj = ((pointer[0] - a[0]) * v0[0] + (pointer[1] - a[1]) * v0[1]) / len2;
  const s = Math.max(proj, minSize / Math.max(1e-6, Math.min(f.w, f.h)), 0.01);
  return { s, r: 0, ox: a[0], oy: a[1], dx: 0, dy: 0 };
}

/** Rotation by dragging the rotate handle from `start` to `pointer`, snapping the frame to every 45° within `snapDeg`. */
export function rotateSim(f: Frame, start: P, pointer: P, snapDeg = 4): Sim {
  let r = Math.atan2(pointer[1] - f.cy, pointer[0] - f.cx) - Math.atan2(start[1] - f.cy, start[0] - f.cx);
  const step = Math.PI / 4;
  const total = f.rot + r;
  const snapped = Math.round(total / step) * step;
  if (Math.abs(total - snapped) <= (snapDeg * Math.PI) / 180) r = snapped - f.rot;
  return { s: 1, r: normAngle(r), ox: f.cx, oy: f.cy, dx: 0, dy: 0 };
}

/**
 * A text box resized from its left or right edge: only the width changes (the text reflows, the font stays),
 * along the box's own direction. The opposite edge stays put.
 */
export function textWidthPatch(it: TextItem, side: 'left' | 'right', pointer: P, minW = 24): Pick<TextItem, 'x' | 'y' | 'w'> {
  const r = it.rot ?? 0;
  const ux = Math.cos(r), uy = Math.sin(r);
  if (side === 'right') {
    const w = Math.max(minW, (pointer[0] - it.x) * ux + (pointer[1] - it.y) * uy);
    return { x: it.x, y: it.y, w };
  }
  const rx = it.x + ux * it.w, ry = it.y + uy * it.w;
  const w = Math.max(minW, (rx - pointer[0]) * ux + (ry - pointer[1]) * uy);
  return { x: rx - ux * w, y: ry - uy * w, w };
}

function pointInQuad(p: P, q: P[]): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i]!, b = q[(i + 1) % 4]!;
    const cr = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    if (cr === 0) continue;
    if (sign === 0) sign = Math.sign(cr);
    else if (Math.sign(cr) !== sign) return false;
  }
  return true;
}

function polylineDist(p: P, pl: P[]): number {
  if (pl.length === 1) return Math.hypot(p[0] - pl[0]![0], p[1] - pl[0]![1]);
  let d = Infinity;
  for (let i = 1; i < pl.length; i++) d = Math.min(d, distToSegment(p, pl[i - 1]!, pl[i]!));
  return d;
}

function closed(pl: P[]): boolean {
  const a = pl[0], b = pl[pl.length - 1];
  return pl.length > 3 && !!a && !!b && Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6;
}

/** How far a tap at `p` is from an item's ink or box (0 on it or inside it). */
export function itemDistance(it: Item, p: P): number {
  switch (it.type) {
    case 'stroke':
      return Math.max(0, polylineDist(p, it.points.map((q): P => [q.x, q.y])) - it.width / 2);
    case 'shape': {
      const pls = shapePolylines(it);
      const edge = Math.max(0, Math.min(...pls.map((pl) => polylineDist(p, pl))) - it.width / 2);
      return edge;
    }
    case 'text':
    case 'image': {
      const q = boxCorners(it);
      if (pointInQuad(p, q)) return 0;
      return polylineDist(p, [...q, q[0]!]);
    }
  }
}

/**
 * The item a tap selects: the nearest within `tol` page units, the topmost on a tie. Taps inside a text box, an
 * image or a closed shape (rectangle, ellipse, …) pick it too, unless ink is within reach. `items` are in z-order (last on top).
 */
export function hitTestPoint(items: readonly Item[], p: { x: number; y: number }, tol: number): string | null {
  const pt: P = [p.x, p.y];
  let best: string | null = null;
  let bestD = Infinity;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    const [x0, y0, x1, y1] = visualBBox(it);
    if (pt[0] < x0 - tol || pt[0] > x1 + tol || pt[1] < y0 - tol || pt[1] > y1 + tol) continue;
    let d = itemDistance(it, pt);
    // Inside a text box or image counts as a near miss, so ink drawn on top of it (within reach) wins the tap.
    if ((it.type === 'text' || it.type === 'image') && d === 0) d = tol * 0.75;
    if (d > tol && it.type === 'shape') {
      const pl = shapePolylines(it)[0];
      if (pl && closed(pl) && pointInPolygon(pt, pl)) d = tol;
    }
    if (d <= tol && d < bestD) {
      best = it.id;
      bestD = d;
    }
  }
  return best;
}

function pointInPolygon(p: P, poly: P[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Ids of the items a dragged rectangle selects (same rule as the lasso: most of the ink, or a box's centre). */
export function boxSelect(items: readonly Item[], a: { x: number; y: number }, b: { x: number; y: number }): string[] {
  const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
  if (x1 - x0 < 1e-6 || y1 - y0 < 1e-6) return [];
  return lassoSelect([...items], [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]);
}
