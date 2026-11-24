// Scribble to erase (tech-spec §2): a quick zig-zag scribbled with the pen over ink deletes the ink it covers, and the
// scribble itself is not kept. Two independent tests must both pass, so handwriting never erases anything:
//
// 1. The stroke is a scribble (`isScribble`): at least SCRIBBLE.minReversals sharp reversals, joined by nearly
//    straight legs that are packed closely side by side (the distance between legs on the same side is small next
//    to their length), drawn quickly. Letters like "m", "w", "MMM" or "N" have reversals too, but their legs are
//    spread out (or curved, or slow); a back-and-forth scribble's legs lie almost on top of each other.
// 2. It covers ink (`scribbleTargets`): strokes and shapes the scribble passes over and that lie mostly inside it.
//    Shading or a scribble over empty paper covers nothing, so it stays ink.
//
// Lengths are in page units (PDF points), converted from mm: the gesture is judged on the page, at any zoom.
import type { InkPoint, Item } from '../types';
import { itemBBox } from './bbox';
import { hitTestErase, pointInPolygon } from './hit';
import { shapePolylines } from './shape';

type P = [number, number];

/** Page units per mm (a page unit is a PDF point, 1/72 inch). */
export const UNITS_PER_MM = 72 / 25.4;

/** The scribble thresholds (mm, ms). Tuned on the corpus in core's scribble tests. */
export const SCRIBBLE = {
  /** Reversals: turns sharper than this (degrees) within `turnMm` of path on either side. */
  turnDeg: 130,
  turnMm: 1.2,
  minReversals: 4,
  /** Legs (the path between two reversals): long enough to be deliberate, and nearly straight (chord / path). */
  minLegMm: 2.5,
  maxLegMm: 120,
  minStraightness: 0.8,
  /**
   * Same-side reversals (two legs apart) are this close, relative to the leg length, for 3 in 4 of them: the legs
   * lie side by side.
   */
  maxPitch: 0.4,
  /** Quick: at least this fast on average, and done within `maxMs`. */
  minSpeedMmPerS: 60,
  maxMs: 3000,
  /** A stroke or shape counts as covered when this share of its points lies inside the scribble. */
  minCovered: 0.6,
} as const;

const mm = (v: number) => v * UNITS_PER_MM;
const dist = (a: P, b: P) => Math.hypot(b[0] - a[0], b[1] - a[1]);

/** Points every `step` along the polyline (its first and last point included). */
function resample(pts: readonly P[], step: number): P[] {
  if (pts.length < 2) return pts.slice();
  const out: P[] = [pts[0]!];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const len = dist(a, b);
    let t = step - carry;
    while (t <= len) {
      out.push([a[0] + ((b[0] - a[0]) * t) / len, a[1] + ((b[1] - a[1]) * t) / len]);
      t += step;
    }
    carry = len - (t - step);
  }
  const last = pts[pts.length - 1]!;
  if (dist(out[out.length - 1]!, last) > step * 0.25) out.push(last);
  return out;
}

/** Indexes of the sharp reversals along a resampled path (`k` samples either side to measure the turn). */
function reversals(r: readonly P[], k: number): number[] {
  const cosMax = Math.cos((SCRIBBLE.turnDeg * Math.PI) / 180);
  const turn: number[] = new Array(r.length).fill(1);
  for (let i = k; i < r.length - k; i++) {
    const a = r[i - k]!;
    const b = r[i]!;
    const c = r[i + k]!;
    const ux = b[0] - a[0], uy = b[1] - a[1];
    const vx = c[0] - b[0], vy = c[1] - b[1];
    const n = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    turn[i] = n ? (ux * vx + uy * vy) / n : 1; // cos of the angle between in and out: -1 is a full reversal
  }
  // Local minima of the cosine under the threshold, at least 2k samples apart.
  const out: number[] = [];
  for (let i = k; i < r.length - k; i++) {
    const t = turn[i]!;
    if (t > cosMax) continue;
    let best = true;
    for (let j = Math.max(0, i - 2 * k); j <= Math.min(r.length - 1, i + 2 * k); j++) {
      if (turn[j]! < t || (turn[j] === t && j < i)) {
        best = false;
        break;
      }
    }
    if (best) out.push(i);
  }
  return out;
}

/** The `q` quantile (0..1) of `xs`, linearly interpolated; 0 for none. */
const quantile = (xs: number[], q: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  return s[lo]! + (s[Math.min(s.length - 1, lo + 1)]! - s[lo]!) * (i - lo);
};
const median = (xs: number[]) => quantile(xs, 0.5);

/** Why a stroke is or isn't a scribble (for tests and tuning). */
export interface ScribbleShape {
  ok: boolean;
  reversals: number;
  leg: number;
  straightness: number;
  pitch: number;
  speed: number;
  ms: number;
}

/** The shape test alone: is this stroke (page units, `t` in ms) a quick back-and-forth scribble? */
export function scribbleShape(points: readonly Pick<InkPoint, 'x' | 'y' | 't'>[]): ScribbleShape {
  const no: ScribbleShape = { ok: false, reversals: 0, leg: 0, straightness: 0, pitch: Infinity, speed: 0, ms: 0 };
  if (points.length < 6) return no;
  const raw: P[] = points.map((q) => [q.x, q.y]);
  let length = 0;
  for (let i = 1; i < raw.length; i++) length += dist(raw[i - 1]!, raw[i]!);
  const ms = Math.max(0, points[points.length - 1]!.t - points[0]!.t);
  const step = mm(0.4);
  const r = resample(raw, step);
  const k = Math.max(1, Math.round(mm(SCRIBBLE.turnMm) / step));
  const rev = reversals(r, k);
  // Legs between consecutive reversals.
  const legs: number[] = [];
  const straight: number[] = [];
  for (let i = 1; i < rev.length; i++) {
    const a = rev[i - 1]!;
    const b = rev[i]!;
    const chord = dist(r[a]!, r[b]!);
    legs.push(chord);
    straight.push(chord / Math.max(1e-6, (b - a) * step));
  }
  // Pitch: how far apart same-side reversals are, next to the legs between them.
  const pitch: number[] = [];
  for (let i = 2; i < rev.length; i++) pitch.push(dist(r[rev[i - 2]!]!, r[rev[i]!]!) / Math.max(1e-6, (legs[i - 2]! + legs[i - 1]!) / 2));
  const speed = ms > 0 ? length / UNITS_PER_MM / (ms / 1000) : Infinity;
  const out: ScribbleShape = {
    ok: false,
    reversals: rev.length,
    leg: median(legs) / UNITS_PER_MM,
    straightness: median(straight),
    // Most leg pairs must lie close together, not just half of them (joined "NNN" alternates close and far).
    pitch: pitch.length ? quantile(pitch, 0.75) : Infinity,
    speed,
    ms,
  };
  out.ok =
    out.reversals >= SCRIBBLE.minReversals &&
    out.leg >= SCRIBBLE.minLegMm &&
    out.leg <= SCRIBBLE.maxLegMm &&
    out.straightness >= SCRIBBLE.minStraightness &&
    out.pitch <= SCRIBBLE.maxPitch &&
    out.speed >= SCRIBBLE.minSpeedMmPerS &&
    out.ms <= SCRIBBLE.maxMs;
  return out;
}

export const isScribble = (points: readonly Pick<InkPoint, 'x' | 'y' | 't'>[]) => scribbleShape(points).ok;

/** Convex hull (monotone chain), counter-clockwise. */
function hull(pts: P[]): P[] {
  const s = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (s.length < 3) return s;
  const cross = (o: P, a: P, b: P) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: P[] = [];
  for (const p of s) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: P[] = [];
  for (let i = s.length - 1; i >= 0; i--) {
    const p = s[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** The hull pushed out by `d` from its centroid (a little room for ink right at the scribble's edge). */
function grow(h: P[], d: number): P[] {
  const cx = h.reduce((s, p) => s + p[0], 0) / h.length;
  const cy = h.reduce((s, p) => s + p[1], 0) / h.length;
  return h.map(([x, y]) => {
    const l = Math.hypot(x - cx, y - cy) || 1;
    return [x + ((x - cx) / l) * d, y + ((y - cy) / l) * d];
  });
}

/**
 * The strokes and shapes a scribble covers: ones it passes over (within its pen width) that lie mostly
 * (SCRIBBLE.minCovered of their points) inside it. Text boxes and images are never covered.
 */
export function scribbleTargets(items: readonly Item[], points: readonly Pick<InkPoint, 'x' | 'y'>[], width: number): string[] {
  if (points.length < 3) return [];
  const h = grow(hull(points.map((q): P => [q.x, q.y])), mm(1) + width / 2);
  if (h.length < 3) return [];
  // Mostly inside first (cheap), then whether the scribble really passes over it (on the scribble resampled every mm).
  const inside: Item[] = [];
  for (const it of items) {
    const pts: P[] = it.type === 'stroke' ? it.points.map((q): P => [q.x, q.y]) : it.type === 'shape' ? shapePolylines(it).flatMap((pl) => resample(pl, mm(1))) : [];
    if (!pts.length) continue;
    const n = pts.filter((p) => pointInPolygon(p, h)).length;
    if (n >= SCRIBBLE.minCovered * pts.length) inside.push(it);
  }
  if (!inside.length) return [];
  const path = resample(points.map((q): P => [q.x, q.y]), mm(1)).map(([x, y]) => ({ x, y }));
  const out = hitTestErase(inside, path, width / 2);
  return out;
}

/**
 * Scribble to erase: the ids a pen stroke deletes (it is a scribble and covers ink), or null when it is ink to keep.
 * Cheap for handwriting: the shape test runs first, and rejects almost every stroke.
 */
export function detectScribble(items: readonly Item[], points: readonly Pick<InkPoint, 'x' | 'y' | 't'>[], width: number): string[] | null {
  if (!isScribble(points)) return null;
  const [x0, y0, x1, y1] = points.reduce<[number, number, number, number]>(
    (b, q) => [Math.min(b[0], q.x), Math.min(b[1], q.y), Math.max(b[2], q.x), Math.max(b[3], q.y)],
    [Infinity, Infinity, -Infinity, -Infinity],
  );
  const near = items.filter((it) => {
    if (it.type !== 'stroke' && it.type !== 'shape') return false;
    const b = itemBBox(it);
    return b[0] <= x1 && b[2] >= x0 && b[1] <= y1 && b[3] >= y0;
  });
  const ids = scribbleTargets(near, points, width);
  return ids.length ? ids : null;
}
