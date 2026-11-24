// Partial erase (tech-spec §2, eraser): the eraser rubs out only the ink it passes over, splitting strokes into
// pieces. Each piece keeps the stroke's tool, colour, width, style, smoothing and its own points' pressure, tilt and
// time, so it looks exactly like the part of the stroke it was. Shapes are not split: partial erasing over a shape
// erases the whole shape (as the whole-stroke eraser does). Text boxes and images are never erased.
import { newId } from '../ids';
import type { InkPoint, Item, StrokeItem } from '../types';
import { pointsBBox } from './bbox';
import { hitTestErase } from './hit';

type XY = { x: number; y: number };

/** What one eraser pass does to a page: strokes replaced by their pieces (none = erased whole), shapes removed. */
export interface ErasePlan {
  /** Each touched stroke and the pieces that replace it (in its place in the z-order). Empty `pieces`: all gone. */
  split: { id: string; pieces: StrokeItem[] }[];
  /** Shapes the eraser touched: erased whole. */
  remove: string[];
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return a + d * t;
}

function lerpPoint(a: InkPoint, b: InkPoint, t: number): InkPoint {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    p: a.p + (b.p - a.p) * t,
    tilt: a.tilt + (b.tilt - a.tilt) * t,
    az: lerpAngle(a.az, b.az, t),
    t: a.t + (b.t - a.t) * t,
  };
}

/**
 * Splits one stroke by the eraser path (page units): the centreline is cut where it comes within `radius` plus half
 * the stroke's width of the path, so the round ends of the pieces just touch the eraser's edge and the gap is as wide
 * as the eraser. Returns null when the eraser misses the stroke, [] when nothing is left, else the pieces (in stroke
 * order). Kept points are the stroke's own (pressure and all); each cut adds one interpolated point at the boundary.
 */
export function splitStroke(s: StrokeItem, path: readonly XY[], radius: number, makeId: () => string = newId): StrokeItem[] | null {
  const pts = s.points;
  if (!pts.length || !path.length) return null;
  const r = radius + s.width / 2;
  // Only the eraser segments that can reach the stroke (a one-point path is a dot: a zero-length segment).
  const [bx0, by0, bx1, by1] = s.bbox;
  const segs: number[] = [];
  for (let i = 0; i < Math.max(1, path.length - 1); i++) {
    const a = path[i]!;
    const b = path[Math.min(i + 1, path.length - 1)]!;
    if (Math.max(a.x, b.x) < bx0 - r || Math.min(a.x, b.x) > bx1 + r || Math.max(a.y, b.y) < by0 - r || Math.min(a.y, b.y) > by1 + r) continue;
    segs.push(a.x, a.y, b.x, b.y);
  }
  if (!segs.length) return null;
  const dist = (x: number, y: number) => {
    let m = Infinity;
    for (let i = 0; i < segs.length; i += 4) {
      const d = segDist(x, y, segs[i]!, segs[i + 1]!, segs[i + 2]!, segs[i + 3]!);
      if (d < m) m = d;
    }
    return m;
  };

  if (pts.length === 1) return dist(pts[0]!.x, pts[0]!.y) <= r ? [] : null;

  const ds = pts.map((q) => dist(q.x, q.y));
  const gone = (d: number) => d <= r;
  // Sample each segment finely where it may come within reach (distance is 1-Lipschitz, so a segment whose ends are
  // both far enough can't), and find each cut by bisection.
  const step = Math.max(0.25, r / 3);
  const pieces: InkPoint[][] = [];
  let piece: InkPoint[] = gone(ds[0]!) ? [] : [pts[0]!];
  let touched = gone(ds[0]!);
  const cut = (a: InkPoint, b: InkPoint, t0: number, t1: number): InkPoint => {
    // t0 is on the kept side, t1 on the erased side (or the other way round): find the boundary.
    const keptAt0 = !gone(dist(a.x + (b.x - a.x) * t0, a.y + (b.y - a.y) * t0));
    let lo = t0;
    let hi = t1;
    for (let k = 0; k < 10; k++) {
      const m = (lo + hi) / 2;
      const kept = !gone(dist(a.x + (b.x - a.x) * m, a.y + (b.y - a.y) * m));
      if (kept === keptAt0) lo = m;
      else hi = m;
    }
    return lerpPoint(a, b, keptAt0 ? lo : hi);
  };
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const da = ds[i - 1]!;
    const db = ds[i]!;
    let ts: number[];
    if ((da + db - len) / 2 > r) ts = [0, 1];
    else {
      const n = Math.max(1, Math.ceil(len / step));
      ts = Array.from({ length: n + 1 }, (_, k) => k / n);
    }
    let prevT = 0;
    let prevGone = gone(da);
    for (let k = 1; k < ts.length; k++) {
      const t = ts[k]!;
      const g = k === ts.length - 1 ? gone(db) : gone(dist(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t));
      if (g) touched = true;
      if (g !== prevGone) {
        const edge = cut(a, b, prevT, t);
        if (g) {
          // Leaving the ink: the piece ends at the cut.
          piece.push(edge);
          pieces.push(piece);
          piece = [];
        } else piece = [edge]; // back on the ink: a new piece starts at the cut
      }
      prevT = t;
      prevGone = g;
    }
    if (!gone(db)) piece.push(b);
  }
  if (piece.length) pieces.push(piece);
  if (!touched) return null;
  const out: StrokeItem[] = [];
  for (const p of pieces) {
    // A piece needs some length to be ink (a cut right at a stroke's end leaves a stub of one or two points).
    let len = 0;
    for (let i = 1; i < p.length; i++) len += Math.hypot(p[i]!.x - p[i - 1]!.x, p[i]!.y - p[i - 1]!.y);
    if (p.length < 2 || len < Math.min(0.5, s.width / 4)) continue;
    out.push({ ...s, id: makeId(), points: p, bbox: pointsBBox(p, s.width / 2) });
  }
  return out;
}

/**
 * One partial-erase pass over a page's items: which strokes split into which pieces, and which shapes go. Only
 * items `hitTestErase` finds are looked at, so a dense page costs about what the whole-stroke eraser does.
 */
export function planPartialErase(items: readonly Item[], path: readonly XY[], radius: number, makeId: () => string = newId): ErasePlan {
  const plan: ErasePlan = { split: [], remove: [] };
  const hit = new Set(hitTestErase(items as Item[], path as XY[], radius));
  if (!hit.size) return plan;
  for (const it of items) {
    if (!hit.has(it.id)) continue;
    if (it.type === 'shape') plan.remove.push(it.id);
    else if (it.type === 'stroke') {
      const pieces = splitStroke(it, path, radius, makeId);
      if (pieces) plan.split.push({ id: it.id, pieces });
    }
  }
  return plan;
}

export const emptyPlan = (p: ErasePlan) => !p.split.length && !p.remove.length;
