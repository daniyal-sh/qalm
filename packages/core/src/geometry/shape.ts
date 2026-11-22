import { newId } from '../ids';
import { pointsBBox } from './bbox';
import type { InkPoint, ShapeItem, ShapeKind } from '../types';

type P = [number, number];

/** Minimum hold (ms) at the end of a stroke before it snaps to a shape. */
export const SNAP_HOLD_MS = 500;
const DEFAULT_COLOR = '#27272a';
const DEFAULT_WIDTH = 1.8;

const dist = (a: P, b: P) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function distToSegment(p: P, a: P, b: P): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function distToPolygon(p: P, poly: P[]): number {
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) d = Math.min(d, distToSegment(p, poly[i]!, poly[(i + 1) % poly.length]!));
  return d;
}

function maxDev(pts: P[], a: P, b: P): number {
  let m = 0;
  for (const p of pts) m = Math.max(m, distToSegment(p, a, b));
  return m;
}

/** Edges or outline of a shape as polylines (ellipse sampled with 48 segments). */
export function shapePolylines(s: Pick<ShapeItem, 'kind' | 'pts'>): P[][] {
  const pts = s.pts;
  switch (s.kind) {
    case 'line':
      return [pts.slice(0, 2)];
    case 'arrow': {
      const [tail, tip] = [pts[0]!, pts[1]!];
      const ang = Math.atan2(tip[1] - tail[1], tip[0] - tail[0]);
      const len = Math.min(16, dist(tail, tip) * 0.3);
      const barb = (da: number): P => [tip[0] - len * Math.cos(ang + da), tip[1] - len * Math.sin(ang + da)];
      return [[tail, tip], [barb(Math.PI / 7), tip, barb(-Math.PI / 7)]];
    }
    case 'rect':
    case 'triangle':
      return [[...pts, pts[0]!]];
    case 'ellipse': {
      const [a, b] = [pts[0]!, pts[1]!];
      const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2, rx = Math.abs(b[0] - a[0]) / 2, ry = Math.abs(b[1] - a[1]) / 2;
      const out: P[] = [];
      for (let i = 0; i <= 48; i++) {
        const t = (i / 48) * Math.PI * 2;
        out.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
      }
      return [out];
    }
  }
}

function make(kind: ShapeKind, pts: P[]): ShapeItem {
  return { id: newId(), type: 'shape', kind, pts, color: DEFAULT_COLOR, width: DEFAULT_WIDTH };
}

/**
 * Snaps a held stroke to a line, arrow, rect, ellipse or triangle, or returns null.
 * Only when `heldMs >= 500`. The result has a fresh id and default style; the caller sets `color` and `width`.
 */
export function snapShape(points: InkPoint[], heldMs: number): ShapeItem | null {
  if (heldMs < SNAP_HOLD_MS || points.length < 2) return null;
  const pts: P[] = points.map((q) => [q.x, q.y]);
  const [x0, y0, x1, y1] = pointsBBox(points);
  const diag = Math.hypot(x1 - x0, y1 - y0);
  if (diag < 8) return null;
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;

  if (dist(first, last) > 0.25 * diag) {
    // Open stroke: line, or arrow (straight shaft to the farthest point, then a short hook back).
    if (maxDev(pts, first, last) <= 0.06 * dist(first, last)) return make('line', [first, last]);
    let tipI = 0;
    pts.forEach((p, i) => {
      if (dist(first, p) > dist(first, pts[tipI]!)) tipI = i;
    });
    const tip = pts[tipI]!;
    const shaft = dist(first, tip);
    const head = pts.slice(tipI);
    const headLen = Math.max(...head.map((p) => dist(p, tip)));
    if (
      maxDev(pts.slice(0, tipI + 1), first, tip) <= 0.06 * shaft &&
      headLen >= 0.08 * shaft &&
      headLen <= 0.4 * shaft
    ) {
      return make('arrow', [first, tip]);
    }
    return null;
  }

  // Closed stroke: fit each shape, keep the best one under its error threshold.
  const w = x1 - x0, h = y1 - y0;
  const size = (w + h) / 2;
  if (Math.min(w, h) < 0.15 * Math.max(w, h)) return null;
  const mean = (fn: (p: P) => number) => pts.reduce((s, p) => s + fn(p), 0) / pts.length;

  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const ellipseErr = mean(([x, y]) => Math.abs(Math.hypot((x - cx) / (w / 2), (y - cy) / (h / 2)) - 1));
  const rect: P[] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const rectErr = mean((p) => distToPolygon(p, rect)) / size;
  // Triangle: farthest point from the centroid, the farthest point from it, then the farthest from that edge.
  const c: P = [mean((p) => p[0]), mean((p) => p[1])];
  const a = pts.reduce((m, p) => (dist(p, c) > dist(m, c) ? p : m));
  const b = pts.reduce((m, p) => (dist(p, a) > dist(m, a) ? p : m));
  const t = pts.reduce((m, p) => (distToSegment(p, a, b) > distToSegment(m, a, b) ? p : m));
  const tri: P[] = [a, b, t];
  const triErr = mean((p) => distToPolygon(p, tri)) / size;

  const fits: [ShapeKind, number, P[]][] = [
    ['ellipse', ellipseErr / 0.1, [[x0, y0], [x1, y1]]],
    ['rect', rectErr / 0.03, rect],
    ['triangle', triErr / 0.03, tri],
  ];
  fits.sort((p, q) => p[1] - q[1]);
  const best = fits[0]!;
  return best[1] < 1 ? make(best[0], best[2]) : null;
}
