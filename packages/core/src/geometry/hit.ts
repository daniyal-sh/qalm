import { distToSegment, shapePolylines } from './shape';
import { itemBBox } from './bbox';
import type { Item } from '../types';

type P = [number, number];
type XY = { x: number; y: number };

function cross(o: P, a: P, b: P): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

function segmentsIntersect(a: P, b: P, c: P, d: P): boolean {
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function segDist(a: P, b: P, c: P, d: P): number {
  if (segmentsIntersect(a, b, c, d)) return 0;
  return Math.min(distToSegment(a, c, d), distToSegment(b, c, d), distToSegment(c, a, b), distToSegment(d, a, b));
}

const segsOf = (pl: P[]): [P, P][] => (pl.length === 1 ? [[pl[0]!, pl[0]!]] : pl.slice(1).map((p, i) => [pl[i]!, p]));

/** Whether polyline `line` comes within `r` of the path's segments (stops at the first hit). */
function polylineWithin(line: P[], path: [P, P][], r: number): boolean {
  for (const [a, b] of segsOf(line)) {
    const sx0 = Math.min(a[0], b[0]) - r, sx1 = Math.max(a[0], b[0]) + r, sy0 = Math.min(a[1], b[1]) - r, sy1 = Math.max(a[1], b[1]) + r;
    for (const [c, d] of path) {
      if (Math.max(c[0], d[0]) < sx0 || Math.min(c[0], d[0]) > sx1 || Math.max(c[1], d[1]) < sy0 || Math.min(c[1], d[1]) > sy1) continue;
      if (segDist(a, b, c, d) <= r) return true;
    }
  }
  return false;
}

/** Ink polylines of an item (strokes and shapes); null for text and images. */
function inkLines(item: Item): { lines: P[][]; halfWidth: number } | null {
  if (item.type === 'stroke') return { lines: [item.points.map((q): P => [q.x, q.y])], halfWidth: item.width / 2 };
  if (item.type === 'shape') return { lines: shapePolylines(item), halfWidth: item.width / 2 };
  return null;
}

/** Ids of strokes and shapes within `radius` of the eraser path. Text boxes and images are not erased. */
export function hitTestErase(items: Item[], path: XY[], radius: number): string[] {
  if (!path.length) return [];
  const pl: P[] = path.map((q) => [q.x, q.y]);
  let px0 = Infinity, py0 = Infinity, px1 = -Infinity, py1 = -Infinity;
  for (const [x, y] of pl) {
    px0 = Math.min(px0, x); py0 = Math.min(py0, y); px1 = Math.max(px1, x); py1 = Math.max(py1, y);
  }
  const segs = segsOf(pl);
  const out: string[] = [];
  for (const item of items) {
    if (item.type !== 'stroke' && item.type !== 'shape') continue;
    // The box first: building every stroke's polyline was most of the cost on a dense page.
    const r0 = radius + item.width / 2;
    const [x0, y0, x1, y1] = itemBBox(item);
    if (x0 - r0 > px1 || x1 + r0 < px0 || y0 - r0 > py1 || y1 + r0 < py0) continue;
    const ink = inkLines(item);
    if (!ink || !ink.lines.some((l) => l.length)) continue;
    const r = radius + ink.halfWidth;
    if (ink.lines.some((l) => l.length && polylineWithin(l, segs, r))) out.push(item.id);
  }
  return out;
}

export function pointInPolygon(p: P, poly: P[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Ids of items inside the lasso: at least half of a stroke's or shape's points, or a box's centre. */
export function lassoSelect(items: Item[], polygon: XY[]): string[] {
  if (polygon.length < 3) return [];
  const poly: P[] = polygon.map((q) => [q.x, q.y]);
  const out: string[] = [];
  for (const item of items) {
    let pts: P[];
    if (item.type === 'stroke') pts = item.points.map((q) => [q.x, q.y]);
    else if (item.type === 'shape') pts = shapePolylines(item).flat();
    else {
      const [x0, y0, x1, y1] = itemBBox(item);
      pts = [[(x0 + x1) / 2, (y0 + y1) / 2]];
    }
    if (!pts.length) continue;
    const inside = pts.filter((p) => pointInPolygon(p, poly)).length;
    if (inside * 2 >= pts.length) out.push(item.id);
  }
  return out;
}
