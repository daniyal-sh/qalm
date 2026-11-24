import { newId } from '../ids';
import { pointsBBox } from './bbox';
import type { InkPoint, ShapeItem, ShapeKind } from '../types';

type P = [number, number];

/**
 * Hold the pen still this long (ms) at the end of a stroke and it snaps to a shape, while the pen is still down (the
 * overlays time the hold; `snapShape` checks it after the fact).
 */
export const SNAP_HOLD_MS = 400;
/**
 * How far (mm) the pen may wobble during that hold, measured from where the hold began (not frame to frame, so a slow
 * drift still ends the hold). A real hand resting on a nib wanders 1–2 mm; 1 mm missed most holds.
 */
export const SNAP_HOLD_TOLERANCE_MM = 2.5;
/** Adjusting a snapped closed shape: a turn this small (degrees) keeps its orientation. */
const ADJUST_TURN_SNAP_DEG = 6;
const DEFAULT_COLOR = '#27272a';
const DEFAULT_WIDTH = 1.8;
/** Resampled points along a stroke. */
const N = 96;
/** Lines and edges this close (degrees) to horizontal or vertical become exactly so. */
const AXIS_SNAP_DEG = 5;

const dist = (a: P, b: P) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const sub = (a: P, b: P): P => [a[0] - b[0], a[1] - b[1]];
const add = (a: P, b: P): P => [a[0] + b[0], a[1] + b[1]];
const mul = (a: P, k: number): P => [a[0] * k, a[1] * k];
const DEG = Math.PI / 180;

export function distToSegment(p: P, a: P, b: P): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function pathLength(pts: P[]): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += dist(pts[i - 1]!, pts[i]!);
  return l;
}

/** `n` points evenly spaced along the polyline. */
export function resample(pts: P[], n: number): P[] {
  const L = pathLength(pts);
  if (pts.length < 2 || L === 0) return pts.slice(0, 1);
  const step = L / (n - 1);
  const out: P[] = [pts[0]!];
  let acc = 0;
  let prev = pts[0]!;
  for (let i = 1; i < pts.length; i++) {
    let cur = pts[i]!;
    let d = dist(prev, cur);
    while (acc + d >= step && out.length < n) {
      const t = (step - acc) / d;
      const q: P = [prev[0] + (cur[0] - prev[0]) * t, prev[1] + (cur[1] - prev[1]) * t];
      out.push(q);
      prev = q;
      d = dist(prev, cur);
      acc = 0;
    }
    acc += d;
    prev = cur;
  }
  while (out.length < n) out.push(pts[pts.length - 1]!);
  return out;
}

/** Ramer–Douglas–Peucker: indices of the kept points. */
function rdp(pts: P[], eps: number, lo = 0, hi = pts.length - 1, out: number[] = []): number[] {
  if (lo === 0 && out.length === 0) out.push(0);
  let best = -1;
  let bd = 0;
  for (let i = lo + 1; i < hi; i++) {
    const d = distToSegment(pts[i]!, pts[lo]!, pts[hi]!);
    if (d > bd) {
      bd = d;
      best = i;
    }
  }
  if (best >= 0 && bd > eps) {
    rdp(pts, eps, lo, best, out);
    rdp(pts, eps, best, hi, out);
  } else out.push(hi);
  return out;
}

/** Turning angle (radians, 0..π) at `pts[i]`, measured over `w` steps on each side (wrapping when `closed`). */
function turnAt(pts: P[], i: number, w: number, closed: boolean): number {
  const n = pts.length;
  const a = closed ? pts[(i - w + n) % n]! : pts[Math.max(0, i - w)]!;
  const b = pts[i]!;
  const c = closed ? pts[(i + w) % n]! : pts[Math.min(n - 1, i + w)]!;
  const u = sub(b, a);
  const v = sub(c, b);
  const lu = Math.hypot(u[0], u[1]);
  const lv = Math.hypot(v[0], v[1]);
  if (!lu || !lv) return 0;
  return Math.acos(Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1]) / (lu * lv))));
}

function meanDistToPolygon(pts: P[], poly: P[], closed = true): number {
  let s = 0;
  for (const p of pts) {
    let d = Infinity;
    const m = closed ? poly.length : poly.length - 1;
    for (let i = 0; i < m; i++) d = Math.min(d, distToSegment(p, poly[i]!, poly[(i + 1) % poly.length]!));
    s += d;
  }
  return s / pts.length;
}

/** An angle snapped to the nearest multiple of 90° when within `deg`. */
function snapAxis(a: number, deg = AXIS_SNAP_DEG): number {
  const q = Math.round(a / (Math.PI / 2)) * (Math.PI / 2);
  return Math.abs(a - q) <= deg * DEG ? q : a;
}

function make(kind: ShapeKind, pts: P[]): ShapeItem {
  return { id: newId(), type: 'shape', kind, pts, color: DEFAULT_COLOR, width: DEFAULT_WIDTH };
}

/** Drops the jitter of the final hold (points within `r` of the last one, at the end). */
function trimHold(pts: P[], r: number): P[] {
  const last = pts[pts.length - 1]!;
  let i = pts.length - 1;
  while (i > 1 && dist(pts[i - 1]!, last) <= r) i--;
  return pts.slice(0, i + 1);
}

/**
 * An ellipse's centre and half-axis vectors. `pts` is either its axis-aligned box `[[x0, y0], [x1, y1]]` (older
 * shapes) or the 4 corners of its (possibly rotated) box, in order, which is what moving and rotating produce.
 */
export function ellipseAxes(pts: readonly P[]): { c: P; u: P; v: P } {
  if (pts.length >= 4) {
    const p0 = pts[0]!, p1 = pts[1]!, p3 = pts[3]!;
    const c: P = [(pts[0]![0] + pts[2]![0]) / 2, (pts[0]![1] + pts[2]![1]) / 2];
    return { c, u: [(p1[0] - p0[0]) / 2, (p1[1] - p0[1]) / 2], v: [(p3[0] - p0[0]) / 2, (p3[1] - p0[1]) / 2] };
  }
  const a: P = pts[0] ?? [0, 0];
  const b: P = pts[1] ?? a;
  return { c: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], u: [Math.abs(b[0] - a[0]) / 2, 0], v: [0, Math.abs(b[1] - a[1]) / 2] };
}

/** Edges or outline of a shape as polylines (ellipse sampled with 64 segments). */
export function shapePolylines(s: Pick<ShapeItem, 'kind' | 'pts'>): P[][] {
  const pts = s.pts;
  switch (s.kind) {
    case 'line':
      return [pts.slice(0, 2)];
    case 'arrow':
    case 'double-arrow': {
      const [tail, tip] = [pts[0]!, pts[1]!];
      const len = Math.min(16, dist(tail, tip) * 0.3);
      const head = (from: P, to: P): P[] => {
        const ang = Math.atan2(to[1] - from[1], to[0] - from[0]);
        const barb = (da: number): P => [to[0] - len * Math.cos(ang + da), to[1] - len * Math.sin(ang + da)];
        return [barb(Math.PI / 7), to, barb(-Math.PI / 7)];
      };
      return s.kind === 'arrow' ? [[tail, tip], head(tail, tip)] : [[tail, tip], head(tail, tip), head(tip, tail)];
    }
    case 'rect':
      if (pts.length === 2) {
        const [a, b] = [pts[0]!, pts[1]!];
        return [[a, [b[0], a[1]], b, [a[0], b[1]], a]];
      }
      return [[...pts, pts[0]!]];
    case 'triangle':
    case 'diamond':
    case 'pentagon':
    case 'hexagon':
    case 'star':
      return [[...pts, pts[0]!]];
    case 'ellipse': {
      const { c, u, v } = ellipseAxes(pts);
      const out: P[] = [];
      for (let i = 0; i <= 64; i++) {
        const t = (i / 64) * Math.PI * 2;
        out.push([c[0] + u[0] * Math.cos(t) + v[0] * Math.sin(t), c[1] + u[1] * Math.cos(t) + v[1] * Math.sin(t)]);
      }
      return [out];
    }
  }
}

// ---------------------------------------------------------------- open strokes: line, arrow, double arrow

function fitLine(a: P, b: P): P[] {
  const ang = snapAxis(Math.atan2(b[1] - a[1], b[0] - a[0]));
  const len = dist(a, b);
  const m = mul(add(a, b), 0.5);
  const h: P = [Math.cos(ang) * len * 0.5, Math.sin(ang) * len * 0.5];
  return [sub(m, h), add(m, h)];
}

/** Is `barb` (from the shaft's end `tip`) an arrow head barb: short and pointing back along the shaft at 15–75°? */
function isBarb(tip: P, back: P, barb: P, shaft: number): boolean {
  const len = dist(tip, barb);
  if (len < 0.06 * shaft || len > 0.5 * shaft) return false;
  const u = sub(back, tip);
  const v = sub(barb, tip);
  const cos = (u[0] * v[0] + u[1] * v[1]) / (Math.hypot(u[0], u[1]) * Math.hypot(v[0], v[1]));
  const ang = Math.acos(Math.max(-1, Math.min(1, cos))) / DEG;
  return ang >= 12 && ang <= 75;
}

function recogniseOpen(pts: P[], diag: number): ShapeItem | null {
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  const chord = dist(first, last);
  // A line: nearly straight all the way.
  let dev = 0;
  for (const p of pts) dev = Math.max(dev, distToSegment(p, first, last));
  if (chord > 0.5 * diag && dev <= Math.max(0.07 * chord, 1.5)) return make('line', fitLine(first, last));

  // Arrows: simplify to a polyline; the longest segment is the shaft, short barbs hang off its ends.
  const idx = rdp(pts, Math.max(0.05 * diag, 1.5));
  const v = idx.map((i) => pts[i]!);
  if (v.length < 3 || v.length > 7) return null;
  let s = 0;
  for (let i = 1; i < v.length - 1; i++) if (dist(v[i]!, v[i + 1]!) > dist(v[s]!, v[s + 1]!)) s = i;
  const a = v[s]!;
  const b = v[s + 1]!;
  const shaft = dist(a, b);
  if (shaft < 0.6 * diag) return null;
  const before = v.slice(0, s).reverse(); // vertices hanging off `a`
  const after = v.slice(s + 2); // vertices hanging off `b`
  // Each end may carry a head: 1 barb, or barb – back to the end – barb.
  const head = (end: P, other: P, hang: P[]): boolean | null => {
    if (!hang.length) return false;
    if (hang.length === 1) return isBarb(end, other, hang[0]!, shaft) ? true : null;
    if (hang.length === 2) {
      // A hook back to the shaft (barb, then back near the end): still a head.
      return isBarb(end, other, hang[0]!, shaft) && dist(hang[1]!, end) < 0.25 * shaft ? true : null;
    }
    if (hang.length === 3) return isBarb(end, other, hang[0]!, shaft) && dist(hang[1]!, end) < 0.15 * shaft && isBarb(end, other, hang[2]!, shaft) ? true : null;
    return null;
  };
  const ha = head(a, b, before);
  const hb = head(b, a, after);
  if (ha === null || hb === null || (!ha && !hb)) return null;
  // Everything else must lie close to the shaft or a barb (a sloppy curve is not an arrow).
  const segs = v.slice(1).map((p, i) => [v[i]!, p] as [P, P]);
  let err = 0;
  for (const p of pts) err += Math.min(...segs.map(([x, y]) => distToSegment(p, x, y)));
  if (err / pts.length > 0.035 * diag) return null;
  const [p0, p1] = fitLine(a, b);
  if (ha && hb) return make('double-arrow', [p0!, p1!]);
  return ha ? make('arrow', [p1!, p0!]) : make('arrow', [p0!, p1!]);
}

// ---------------------------------------------------------------- closed strokes

/** Where a closed stroke first comes back to its start (overshoot at the closure is cut off). */
function closeLoop(pts: P[], diag: number): P[] | null {
  const first = pts[0]!;
  const L = pathLength(pts);
  let acc = 0;
  let best = -1;
  let bestD = Infinity;
  for (let i = 1; i < pts.length; i++) {
    acc += dist(pts[i - 1]!, pts[i]!);
    if (acc < 0.6 * L) continue;
    const d = dist(pts[i]!, first);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  if (best < 0 || bestD > 0.2 * diag) return null;
  // A short overshoot past the start is fine; a long tail (the stem of an "a", the end of an "e") is handwriting.
  const loopLen = pathLength(pts.slice(0, best + 1));
  if (L - loopLen > 0.18 * loopLen) return null;
  return pts.slice(0, best + 1);
}

interface EllipseFit {
  c: P;
  rx: number;
  ry: number;
  ang: number;
  err: number;
}

/** Principal axes of the points, and the radii and centre of their spread along those axes. */
function fitEllipse(pts: P[]): EllipseFit {
  const n = pts.length;
  const c: P = [pts.reduce((s, p) => s + p[0], 0) / n, pts.reduce((s, p) => s + p[1], 0) / n];
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of pts) {
    const dx = p[0] - c[0], dy = p[1] - c[1];
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  sxx /= n;
  syy /= n;
  sxy /= n;
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const ca = Math.cos(ang), sa = Math.sin(ang);
  // Radii: half the spread along each axis (ignoring the outermost 2% as jitter).
  const us = pts.map((p) => (p[0] - c[0]) * ca + (p[1] - c[1]) * sa).sort((a, b) => a - b);
  const vs = pts.map((p) => -(p[0] - c[0]) * sa + (p[1] - c[1]) * ca).sort((a, b) => a - b);
  const q = Math.floor(n * 0.02);
  const rx = Math.max(1e-6, (us[n - 1 - q]! - us[q]!) / 2);
  const ry = Math.max(1e-6, (vs[n - 1 - q]! - vs[q]!) / 2);
  // The centre of that spread (an uneven stroke pulls the centroid off-centre).
  const cu = (us[n - 1 - q]! + us[q]!) / 2, cv = (vs[n - 1 - q]! + vs[q]!) / 2;
  c[0] += cu * ca - cv * sa;
  c[1] += cu * sa + cv * ca;
  let err = 0;
  for (const p of pts) {
    const dx = p[0] - c[0], dy = p[1] - c[1];
    const u = dx * ca + dy * sa, v = -dx * sa + dy * ca;
    // radial distance from the ellipse, relative to its size
    const r = Math.hypot(u / rx, v / ry);
    err += Math.abs(r - 1) * Math.hypot(u, v) / Math.max(r, 1e-9);
  }
  return { c, rx, ry, ang, err: err / n / ((rx + ry) / 2) };
}

function ellipseCorners(f: EllipseFit): P[] {
  let { rx, ry, ang } = f;
  // Nearly round: a circle. Nearly upright: upright.
  if (Math.abs(rx - ry) <= 0.1 * Math.max(rx, ry)) {
    rx = ry = (rx + ry) / 2;
    ang = 0;
  } else ang = snapAxis(ang, 8);
  const u: P = [Math.cos(ang) * rx, Math.sin(ang) * rx];
  const v: P = [-Math.sin(ang) * ry, Math.cos(ang) * ry];
  const c = f.c;
  return [sub(sub(c, u), v), sub(add(c, u), v), add(add(c, u), v), add(sub(c, u), v)];
}

/**
 * Corners of a closed loop (evenly resampled): points where the stroke turns by more than 35° (and well above its
 * typical turn) within a short window on each side (≈ 4% of the outline), keeping only the peak of each turn. A
 * hand-rounded corner still turns by its full angle over the window, while a circle turns evenly, ~30° everywhere.
 */
function cornerIndices(ring: P[]): number[] {
  const n = ring.length;
  const w = Math.max(3, Math.round(n / 24));
  const th = ring.map((_, i) => turnAt(ring, i, w, true));
  // A circle turns evenly (its median turn is high); a polygon's edges barely turn at all.
  const median = [...th].sort((a, b) => a - b)[n >> 1]!;
  const min = Math.max(35 * DEG, 1.6 * median);
  const out: P[] = [];
  for (let i = 0; i < n; i++) {
    if (th[i]! < min) continue;
    let peak = true;
    for (let d = 1; d <= w && peak; d++) {
      if (th[(i - d + n) % n]! >= th[i]!) peak = false; // the earlier of equal values wins
      if (th[(i + d) % n]! > th[i]!) peak = false;
    }
    if (peak) out.push(i);
  }
  return out;
}

/**
 * Sharper corners for a hand-drawn polygon: a line fitted through the middle of each side (between corners `idx` of
 * the closed `ring`), and each corner where neighbouring sides meet. A hand rounds corners off, so the turning points
 * themselves sit inside the shape; the sides are what the hand drew straight. A corner whose sides are nearly parallel
 * or meet far from it keeps the turning point.
 */
function refineCorners(ring: P[], idx: number[], size: number): P[] {
  const n = ring.length;
  const k = idx.length;
  const lines = idx.map((a, i) => {
    const b = idx[(i + 1) % k]!;
    const span = (b - a + n) % n || n;
    const side: P[] = [];
    for (let j = Math.ceil(span * 0.2); j <= Math.floor(span * 0.8); j++) side.push(ring[(a + j) % n]!);
    if (side.length < 2) return null;
    // Total least squares: through the centroid, along the principal direction.
    const c: P = [side.reduce((m, p) => m + p[0], 0) / side.length, side.reduce((m, p) => m + p[1], 0) / side.length];
    let sxx = 0, syy = 0, sxy = 0;
    for (const p of side) {
      const dx = p[0] - c[0], dy = p[1] - c[1];
      sxx += dx * dx;
      syy += dy * dy;
      sxy += dx * dy;
    }
    const t = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    return { c, d: [Math.cos(t), Math.sin(t)] as P };
  });
  return idx.map((ci, i) => {
    const l1 = lines[(i - 1 + k) % k], l2 = lines[i];
    const turn = ring[ci]!;
    if (!l1 || !l2) return turn;
    const den = l1.d[0] * l2.d[1] - l1.d[1] * l2.d[0];
    if (Math.abs(den) < Math.sin(20 * DEG)) return turn;
    const w = sub(l2.c, l1.c);
    const t = (w[0] * l2.d[1] - w[1] * l2.d[0]) / den;
    const q = add(l1.c, mul(l1.d, t));
    return dist(q, turn) <= 0.25 * size ? q : turn;
  });
}

/**
 * A rectangle fitted to a closed outline as a whole (for corners rounded off so far that no corner turns sharply): its
 * orientation from the outline's segment directions folded to 0..90° (straight sides dominate), its sides at the
 * outline's robust extents along those axes.
 */
function fitBox(ring: P[]): P[] {
  let sx = 0, sy = 0;
  for (let i = 0; i < ring.length; i++) {
    const e = sub(ring[(i + 1) % ring.length]!, ring[i]!);
    const a = Math.atan2(e[1], e[0]) * 4;
    const l = Math.hypot(e[0], e[1]);
    sx += Math.cos(a) * l;
    sy += Math.sin(a) * l;
  }
  const ang = Math.atan2(sy, sx) / 4;
  const ca = Math.cos(ang), sa = Math.sin(ang);
  const us = ring.map((p) => p[0] * ca + p[1] * sa).sort((a, b) => a - b);
  const vs = ring.map((p) => -p[0] * sa + p[1] * ca).sort((a, b) => a - b);
  const q = Math.floor(ring.length * 0.02);
  const [u0, u1, v0, v1] = [us[q]!, us[us.length - 1 - q]!, vs[q]!, vs[vs.length - 1 - q]!];
  const back = (u: number, v: number): P => [u * ca - v * sa, u * sa + v * ca];
  return [back(u0, v0), back(u1, v0), back(u1, v1), back(u0, v1)];
}

/** An ellipse's outline as a closed polygon (64 sides). */
function ellipseOutline(corners4: P[]): P[] {
  return shapePolylines({ kind: 'ellipse', pts: corners4 })[0]!.slice(0, -1);
}

function rectFrom(v: P[]): P[] {
  // Orientation: the mean direction of the 4 edges, folded to 0..90°.
  let sx = 0, sy = 0;
  for (let i = 0; i < 4; i++) {
    const e = sub(v[(i + 1) % 4]!, v[i]!);
    const a = Math.atan2(e[1], e[0]) * 4; // ×4 folds the four edge directions together
    const l = Math.hypot(e[0], e[1]);
    sx += Math.cos(a) * l;
    sy += Math.sin(a) * l;
  }
  const ang = snapAxis(Math.atan2(sy, sx) / 4);
  const ca = Math.cos(ang), sa = Math.sin(ang);
  const us = v.map((p) => p[0] * ca + p[1] * sa);
  const vs = v.map((p) => -p[0] * sa + p[1] * ca);
  // Robust extents: the mean of the two outermost corners on each side.
  const sortU = [...us].sort((a, b) => a - b);
  const sortV = [...vs].sort((a, b) => a - b);
  let u0 = (sortU[0]! + sortU[1]!) / 2, u1 = (sortU[2]! + sortU[3]!) / 2;
  let v0 = (sortV[0]! + sortV[1]!) / 2, v1 = (sortV[2]! + sortV[3]!) / 2;
  // Nearly square: a square.
  const w = u1 - u0, h = v1 - v0;
  if (Math.abs(w - h) <= 0.1 * Math.max(w, h)) {
    const m = (w + h) / 2, cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
    [u0, u1, v0, v1] = [cu - m / 2, cu + m / 2, cv - m / 2, cv + m / 2];
  }
  const back = (u: number, w2: number): P => [u * ca - w2 * sa, u * sa + w2 * ca];
  return [back(u0, v0), back(u1, v0), back(u1, v1), back(u0, v1)];
}

/** Interior angles (degrees) of a polygon. */
function interiorAngles(v: P[]): number[] {
  return v.map((p, i) => {
    const a = sub(v[(i - 1 + v.length) % v.length]!, p);
    const b = sub(v[(i + 1) % v.length]!, p);
    const cos = (a[0] * b[0] + a[1] * b[1]) / (Math.hypot(a[0], a[1]) * Math.hypot(b[0], b[1]));
    return Math.acos(Math.max(-1, Math.min(1, cos))) / DEG;
  });
}

/** A regular polygon (or star when `inner` is set) fitted to drawn corners `v`. */
function regular(v: P[], inner?: number): P[] | null {
  const k = v.length;
  const c: P = [v.reduce((s, p) => s + p[0], 0) / k, v.reduce((s, p) => s + p[1], 0) / k];
  const rs = v.map((p) => dist(p, c));
  const R = rs.reduce((a, b) => a + b, 0) / k;
  if (Math.max(...rs.map((r) => Math.abs(r - R))) > 0.35 * R) return null;
  // Phase: average the corners' angles folded by the k-fold symmetry; prefer a point at the top when close.
  let sx = 0, sy = 0;
  for (const p of v) {
    const a = Math.atan2(p[1] - c[1], p[0] - c[0]) * k;
    sx += Math.cos(a);
    sy += Math.sin(a);
  }
  let phase = Math.atan2(sy, sx) / k;
  const step = (2 * Math.PI) / k;
  const top = -Math.PI / 2;
  const off = ((((phase - top) % step) + step + step / 2) % step) - step / 2;
  if (Math.abs(off) <= 6 * DEG) phase = top;
  else if (k % 2 === 0 && Math.abs(Math.abs(off) - step / 2) <= 6 * DEG) phase = top + step / 2;
  const out: P[] = [];
  for (let i = 0; i < k; i++) {
    const a = phase + i * step;
    out.push([c[0] + R * Math.cos(a), c[1] + R * Math.sin(a)]);
    if (inner) {
      const b = a + step / 2;
      out.push([c[0] + R * inner * Math.cos(b), c[1] + R * inner * Math.sin(b)]);
    }
  }
  return out;
}

/** The regular `k`-gon closest to an outline: centred on it, mean radius, best of 60 rotations. */
function fitRegular(pts: P[], k: number): P[] {
  const n = pts.length;
  const c: P = [pts.reduce((s, p) => s + p[0], 0) / n, pts.reduce((s, p) => s + p[1], 0) / n];
  // A regular polygon's mean radius is ~ (1 + cos(π/k)) / 2 of its corner radius.
  const R = pts.reduce((s, p) => s + dist(p, c), 0) / n / ((1 + Math.cos(Math.PI / k)) / 2);
  const step = (2 * Math.PI) / k;
  let best: P[] = [];
  let bestErr = Infinity;
  for (let i = 0; i < 60; i++) {
    const poly = Array.from({ length: k }, (_, j) => {
      const a = (i / 60) * step + j * step;
      return [c[0] + R * Math.cos(a), c[1] + R * Math.sin(a)] as P;
    });
    const err = meanDistToPolygon(pts, poly);
    if (err < bestErr) {
      bestErr = err;
      best = poly;
    }
  }
  return regular(best) ?? best;
}

function recogniseClosed(loop: P[], diag: number): ShapeItem | null {
  const pts = resample(loop, N);
  const size = diag / Math.SQRT2;
  const ringPts = pts.slice(0, -1);
  const idx = cornerIndices(ringPts);
  const turns = idx.map((i) => ringPts[i]!);
  const k = idx.length;
  const ell = fitEllipse(ringPts);
  // Polygons use the corners where their fitted sides meet; the star its sharp tips as they are.
  const cs = k >= 3 && k <= 6 ? refineCorners(ringPts, idx, size) : turns;
  if ((globalThis as any).DBG) console.log('k', k, 'ellErr', ell.err.toFixed(3), 'ang', interiorAngles(cs).map((a) => a.toFixed(0)).join(','));

  // A pentagram drawn in one go: 5 sharp tips, visited every other one (turns of ~144°).
  if (k === 5) {
    const ang = interiorAngles(turns);
    if (ang.every((a) => a < 60)) {
      // Tips of a star in drawing order skip one: reorder around the centre.
      const c: P = [turns.reduce((s, p) => s + p[0], 0) / 5, turns.reduce((s, p) => s + p[1], 0) / 5];
      const tips = [...turns].sort((a, b) => Math.atan2(a[1] - c[1], a[0] - c[0]) - Math.atan2(b[1] - c[1], b[0] - c[0]));
      const star = regular(tips, 0.382);
      if (star && meanDistToPolygon(pts, star) / size < 0.09) return make('star', star);
      return null;
    }
  }

  if (k >= 3 && k <= 6) {
    let poly: P[] | null = null;
    let kind: ShapeKind | null = null;
    if (k === 3) {
      kind = 'triangle';
      poly = cs;
    } else if (k === 4) {
      const ang = interiorAngles(cs);
      // Diamond: corners at the top, right, bottom and left (its diagonals near upright, its edges not).
      const axisOff = (a: P, b: P) => {
        const t = Math.atan2(b[1] - a[1], b[0] - a[0]);
        return Math.abs(t - snapAxis(t, 90)) / DEG;
      };
      const diagonalsUpright = axisOff(cs[0]!, cs[2]!) <= 12 && axisOff(cs[1]!, cs[3]!) <= 12;
      const edgesUpright = [0, 1, 2, 3].some((i) => axisOff(cs[i]!, cs[(i + 1) % 4]!) <= 15);
      if (ang.every((a) => Math.abs(a - 90) <= 18) && !(diagonalsUpright && !edgesUpright)) {
        kind = 'rect';
        poly = rectFrom(cs);
      } else {
        kind = 'diamond';
        // Through the corners' centre along the two diagonals (upright when nearly so).
        const c = mul(add(mul(add(cs[0]!, cs[2]!), 0.5), mul(add(cs[1]!, cs[3]!), 0.5)), 0.5);
        const half = (a: P, b: P): P => {
          const d = mul(sub(a, b), 0.5);
          const t = snapAxis(Math.atan2(d[1], d[0]), 12);
          const l = Math.hypot(d[0], d[1]);
          return [Math.cos(t) * l, Math.sin(t) * l];
        };
        const u = half(cs[0]!, cs[2]!);
        const v = half(cs[1]!, cs[3]!);
        poly = [add(c, u), add(c, v), sub(c, u), sub(c, v)];
      }
    } else {
      kind = k === 5 ? 'pentagon' : 'hexagon';
      poly = regular(cs);
    }
    if (poly && kind) {
      const err = meanDistToPolygon(pts, poly) / size;
      if ((globalThis as any).DBG) console.log(' poly', kind, err.toFixed(3));
      if (err < 0.06) return make(kind, poly);
    }
  }
  // A pentagon or hexagon with a corner missed (or one too many): fit both to the whole outline.
  if (k >= 4 && k <= 7) {
    const fits = ([5, 6] as const).map((m) => {
      const poly = fitRegular(pts, m);
      return { m, poly, err: meanDistToPolygon(pts, poly) / size };
    });
    const best = fits[0]!.err <= fits[1]!.err ? fits[0]! : fits[1]!;
    if (best.err < 0.035 && Math.abs(best.m - k) <= 1) return make(best.m === 5 ? 'pentagon' : 'hexagon', best.poly);
  }
  // A rectangle with its corners rounded off (few or no sharp turns): the outline hugs its box closer than any
  // ellipse does (a circle stays ~11% of its radius from its box; an ellipse fits it within ~3%).
  if (k <= 4 && Math.min(ell.rx, ell.ry) > 0.12 * Math.max(ell.rx, ell.ry)) {
    const box = fitBox(ringPts);
    const boxErr = meanDistToPolygon(pts, box) / size;
    const ellErr = meanDistToPolygon(pts, ellipseOutline(ellipseCorners(ell))) / size;
    if ((globalThis as any).DBG) console.log(' box', boxErr.toFixed(3), 'ell', ellErr.toFixed(3));
    if (boxErr < 0.04 && boxErr < 0.7 * ellErr) return make('rect', rectFrom(box));
  }
  // Round: an ellipse (or circle). With corners found but no polygon fitting, only a close fit.
  if (ell.err < (k <= 2 ? 0.11 : 0.07) && Math.min(ell.rx, ell.ry) > 0.12 * Math.max(ell.rx, ell.ry)) return make('ellipse', ellipseCorners(ell));
  return null;
}

/**
 * The shape a stroke looks like, or null; no hold needed (the overlays call it once they see the hold, with the
 * points up to where the hold began). Open strokes: line (snapped to horizontal / vertical within 5°), arrow, double
 * arrow. Closed strokes (overshoot at the closure is fine): rectangle (any rotation; squares), ellipse (any rotation;
 * circles), triangle, diamond, pentagon, hexagon, 5-point star. The result has a fresh id and the default style; the
 * caller sets colour and width.
 */
export function recognizeShape(points: readonly { x: number; y: number }[]): ShapeItem | null {
  if (points.length < 2) return null;
  const [x0, y0, x1, y1] = pointsBBox(points);
  const diag = Math.hypot(x1 - x0, y1 - y0);
  if (diag < 8) return null;
  let raw: P[] = points.map((q) => [q.x, q.y]);
  raw = trimHold(raw, Math.max(1, 0.015 * diag));
  if (raw.length < 2) return null;
  const pts = resample(raw, N);
  const L = pathLength(pts);
  const loop = dist(pts[0]!, pts[pts.length - 1]!) < 0.25 * diag || L > 2.2 * diag ? closeLoop(pts, diag) : null;
  if (loop) return recogniseClosed(loop, diag);
  return recogniseOpen(raw, diag); // the drawn points: an arrow's tip stays exactly where it was drawn
}

/** `recognizeShape`, only when the pen was held still for `SNAP_HOLD_MS` at the end (`heldMs`). */
export function snapShape(points: InkPoint[], heldMs: number): ShapeItem | null {
  return heldMs < SNAP_HOLD_MS ? null : recognizeShape(points);
}

const OPEN_KINDS: ReadonlySet<ShapeKind> = new Set(['line', 'arrow', 'double-arrow']);

/**
 * Adjusting a snapped shape while the pen is still down: the pen was at `from` when it snapped and is at `to` now.
 * Returns the shape's new `pts` (same kind).
 * - Lines and arrows: the end nearest the pen follows it (by the pen's offset, so it doesn't jump), the other end
 *   stays; the line snaps to horizontal / vertical within 5°, as when it was recognised.
 * - Closed shapes: scaled and turned about their centre, by how the pen moved relative to it (distance and angle from
 *   the centre, measured from `from`). Uniform scale, so a circle stays a circle and a square a square. A turn under
 *   6° keeps the snapped orientation; rectangles and ellipses also come upright within 6°.
 */
export function adjustShape(s: Pick<ShapeItem, 'kind' | 'pts'>, from: readonly [number, number], to: readonly [number, number]): P[] {
  const pts = s.pts.map((p) => [p[0], p[1]] as P);
  const f: P = [from[0], from[1]];
  const t: P = [to[0], to[1]];
  if (OPEN_KINDS.has(s.kind)) {
    const a = pts[0], b = pts[1];
    if (!a || !b) return pts;
    const moveB = dist(b, f) <= dist(a, f);
    const fixed = moveB ? a : b;
    const end = add(moveB ? b : a, sub(t, f));
    const len = dist(fixed, end);
    if (len < 1) return pts;
    const ang = snapAxis(Math.atan2(end[1] - fixed[1], end[0] - fixed[0]));
    const e: P = [fixed[0] + Math.cos(ang) * len, fixed[1] + Math.sin(ang) * len];
    return moveB ? [fixed, e] : [e, fixed];
  }
  if (!pts.length) return pts;
  const c: P = [pts.reduce((m, p) => m + p[0], 0) / pts.length, pts.reduce((m, p) => m + p[1], 0) / pts.length];
  const u = sub(f, c);
  const v = sub(t, c);
  const lu = Math.hypot(u[0], u[1]);
  const lv = Math.hypot(v[0], v[1]);
  if (lu < 1e-6 || lv < 1e-6) return pts;
  const k = Math.min(50, Math.max(0.05, lv / lu));
  let th = Math.atan2(v[1], v[0]) - Math.atan2(u[1], u[0]);
  th = Math.atan2(Math.sin(th), Math.cos(th));
  if (Math.abs(th) <= ADJUST_TURN_SNAP_DEG * DEG) th = 0;
  else if ((s.kind === 'rect' || s.kind === 'ellipse') && pts.length >= 4) {
    const a0 = Math.atan2(pts[1]![1] - pts[0]![1], pts[1]![0] - pts[0]![0]);
    th = snapAxis(a0 + th, ADJUST_TURN_SNAP_DEG) - a0;
  }
  const cos = Math.cos(th) * k, sin = Math.sin(th) * k;
  return pts.map(([x, y]) => {
    const dx = x - c[0], dy = y - c[1];
    return [c[0] + dx * cos - dy * sin, c[1] + dx * sin + dy * cos] as P;
  });
}
