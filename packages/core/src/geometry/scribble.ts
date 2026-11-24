// Scribble to erase (tech-spec §2): a quick zig-zag scribbled with the pen over ink deletes the ink it covers, and the
// scribble itself is not kept. Two independent tests must both pass, so handwriting never erases anything:
//
// 1. The stroke is a scribble (`isScribble`): at least SCRIBBLE.minReversals sharp reversals, joined by nearly
//    straight legs that are packed closely side by side (the distance between legs on the same side is small next
//    to their length), drawn quickly. Letters like "m", "w", "MMM" or "N" have reversals too, but their legs are
//    spread out (or curved, or slow); a back-and-forth scribble's legs lie almost on top of each other.
// 2. It covers ink (`scribbleTargets`): strokes and shapes that lie mostly inside it and that it crosses, back and
//    forth, with the middles of several legs. Shading or a scribble over empty paper covers nothing, so it stays ink;
//    so does shading inside an outline (a box, a circle): its legs turn at the outline, so their middles never cross
//    it, and an outline whose box holds the whole scribble is never a target.
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
  /** A stroke or shape counts as covered when this share of its points lies inside the scribble… */
  minCovered: 0.6,
  /**
   * …and the middles of this many legs cross it (each leg without `legTrimMm` at either end, where it turns: shading
   * turns at the outline it fills, a scribble turns beyond the ink it rubs out). Marks smaller than `smallMm` across (a
   * dot) need one.
   */
  minCrossLegs: 3,
  legTrimMm: 1.2,
  smallMm: 4,
  /**
   * Never a target: a closed outline whose box, grown by `enclosesShare` of its shorter side (kept within
   * `enclosesMm`), holds the whole scribble: it's being filled in, like a checkbox ticked with a zig-zag that overshoots
   * it a little.
   */
  enclosesShare: 0.4,
  enclosesMm: [1.5, 3],
  /**
   * Shading, so nothing is a target: `shadeShare` of the scribble's turns lie within `shadeTurnMm` of a closed
   * outline whose box (grown as above) holds `surroundShare` of them. Shading turns at the outline it fills, a scribble
   * beyond the ink it rubs out; so shading a box never erases what's written inside it.
   */
  shadeTurnMm: 1.5,
  shadeShare: 0.6,
  surroundShare: 0.8,
  /**
   * …unless the ink inside the outline spans `boxedShare` of it one way and `boxedOther` the other (a word fills a
   * box's width more than its height): a boxed answer being scribbled out, not the box being shaded.
   */
  boxedShare: 0.6,
  boxedOther: 0.4,
  /**
   * A stroke is such an outline only when it is closed and either box-like (`outlineCorners` corners of `cornerDeg`+)
   * or at least `outlineMm` across: a small round closed stroke is a letter (o, 0, 8, a, e), not something to shade.
   */
  outlineCorners: 3,
  cornerDeg: 60,
  /** …and fills `boxFill` of its own box (a box ~0.9–1; an o 0.79; an 8 about 0, its loops cancel). */
  boxFill: 0.85,
  outlineMm: 8,
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
  const raw = points.map((q): P => [q.x, q.y]);
  const h = grow(hull(raw), mm(1) + width / 2);
  if (h.length < 3) return [];
  const [sx0, sy0, sx1, sy1] = raw.reduce<[number, number, number, number]>(
    (b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)],
    [Infinity, Infinity, -Infinity, -Infinity],
  );
  const { legs, turns } = scribbleLegs(raw);
  const pathOf = (it: Item): P[] =>
    it.type === 'stroke' ? it.points.map((q): P => [q.x, q.y]) : it.type === 'shape' ? shapePolylines(it).flatMap((pl) => resample(pl, mm(1))) : [];
  // Filling in an outline (its turns along it) is shading: nothing is a target, not even ink written inside it.
  for (const it of items) {
    if (isOutline(it) && !isBoxedAnswer(it, items) && isShadingInside(it, pathOf(it), turns)) return [];
  }
  // Mostly inside (cheap), and not an outline around the whole scribble.
  const inside: Item[] = [];
  for (const it of items) {
    const pts = pathOf(it);
    if (!pts.length) continue;
    const b = itemBBox(it);
    const pad = enclosePad(b);
    if (isOutline(it) && b[0] - pad <= sx0 && b[1] - pad <= sy0 && b[2] + pad >= sx1 && b[3] + pad >= sy1) continue;
    const n = pts.filter((p) => pointInPolygon(p, h)).length;
    if (n >= SCRIBBLE.minCovered * pts.length) inside.push(it);
  }
  if (!inside.length) return [];
  // Then whether the scribble really crosses it: the middles of enough legs pass over it.
  const out: string[] = [];
  for (const it of inside) {
    const b = itemBBox(it);
    const need = Math.hypot(b[2] - b[0], b[3] - b[1]) < mm(SCRIBBLE.smallMm) ? 1 : SCRIBBLE.minCrossLegs;
    let crossing = 0;
    for (const leg of legs) {
      if (hitTestErase([it], leg, width / 2).length && ++crossing >= need) break;
    }
    if (crossing >= need) out.push(it.id);
  }
  return out;
}

/**
 * An outline shading fills in: a snapped closed shape, or a closed stroke that is box-like (three or more corners: a
 * box, a checkbox, a triangle) or about 8 mm across or more (a ring drawn around something). A small round closed
 * stroke (o, 0, 8) is a letter: a scribble over it rubs it out.
 */
function isOutline(it: Item): boolean {
  if (it.type === 'shape') return it.kind !== 'line' && it.kind !== 'arrow' && it.kind !== 'double-arrow';
  if (it.type !== 'stroke' || it.points.length < 3) return false;
  const a = it.points[0]!;
  const z = it.points[it.points.length - 1]!;
  const [x0, y0, x1, y1] = itemBBox(it);
  if (Math.hypot(z.x - a.x, z.y - a.y) > Math.max(mm(1.5), 0.2 * Math.hypot(x1 - x0, y1 - y0))) return false;
  if ((x1 - x0 + (y1 - y0)) / 2 >= mm(SCRIBBLE.outlineMm)) return true;
  // Small: only a box (sharp corners, and it fills its own box): not an o or 0 (round), nor an 8 (its loops cancel).
  const pts = it.points.map((q): P => [q.x, q.y]);
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    area += a[0] * b[1] - b[0] * a[1];
  }
  // Against the points' own extent (the item's box includes the pen's width).
  const w = Math.max(...pts.map((q) => q[0])) - Math.min(...pts.map((q) => q[0]));
  const h = Math.max(...pts.map((q) => q[1])) - Math.min(...pts.map((q) => q[1]));
  const fill = Math.abs(area) / 2 / Math.max(1e-9, w * h);
  return fill >= SCRIBBLE.boxFill && corners(pts) >= SCRIBBLE.outlineCorners;
}

/** Sharp corners along a path: turns of SCRIBBLE.cornerDeg or more, measured over 1 mm either side. */
function corners(raw: readonly P[]): number {
  const step = mm(0.5);
  const r = resample(raw, step);
  const k = Math.max(1, Math.round(mm(1) / step));
  const min = (SCRIBBLE.cornerDeg * Math.PI) / 180;
  const turn = r.map((b, i) => {
    if (i < k || i >= r.length - k) return 0;
    const a = r[i - k]!;
    const c = r[i + k]!;
    const u = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const v = Math.atan2(c[1] - b[1], c[0] - b[0]);
    let d = Math.abs(v - u);
    if (d > Math.PI) d = 2 * Math.PI - d;
    return d;
  });
  let n = 0;
  for (let i = k; i < r.length - k; i++) {
    if (turn[i]! < min) continue;
    let peak = true;
    for (let j = Math.max(0, i - 2 * k); j <= Math.min(r.length - 1, i + 2 * k); j++) {
      if (turn[j]! > turn[i]! || (turn[j] === turn[i] && j < i)) {
        peak = false;
        break;
      }
    }
    if (peak) n++;
  }
  return n;
}

/** Whether the other ink inside `outline` fills it like a boxed answer (SCRIBBLE.boxedShare / boxedOther). */
function isBoxedAnswer(outline: Item, items: readonly Item[]): boolean {
  const o = itemBBox(outline);
  let box: number[] | null = null;
  for (const it of items) {
    if (it === outline || (it.type !== 'stroke' && it.type !== 'shape' && it.type !== 'text')) continue;
    const b = itemBBox(it);
    const cx = (b[0] + b[2]) / 2;
    const cy = (b[1] + b[3]) / 2;
    if (cx < o[0] || cx > o[2] || cy < o[1] || cy > o[3]) continue;
    box = box ? [Math.min(box[0]!, b[0]), Math.min(box[1]!, b[1]), Math.max(box[2]!, b[2]), Math.max(box[3]!, b[3])] : [b[0], b[1], b[2], b[3]];
  }
  if (!box) return false;
  const wide = (box[2]! - box[0]!) / Math.max(1e-9, o[2] - o[0]);
  const tall = (box[3]! - box[1]!) / Math.max(1e-9, o[3] - o[1]);
  return Math.max(wide, tall) >= SCRIBBLE.boxedShare && Math.min(wide, tall) >= SCRIBBLE.boxedOther;
}

/** How far beyond its box an outline still holds a scribble (`SCRIBBLE.enclosesShare` of its shorter side). */
function enclosePad(b: readonly number[]): number {
  const [lo, hi] = SCRIBBLE.enclosesMm;
  const side = Math.min(b[2]! - b[0]!, b[3]! - b[1]!) / UNITS_PER_MM;
  return mm(Math.min(hi, Math.max(lo, SCRIBBLE.enclosesShare * side)));
}

/** Distance from `p` to the polyline `pl`. */
function distToPath(p: P, pl: readonly P[]): number {
  if (pl.length === 1) return dist(p, pl[0]!);
  let m = Infinity;
  for (let i = 1; i < pl.length; i++) {
    const a = pl[i - 1]!;
    const b = pl[i]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
    m = Math.min(m, Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t));
  }
  return m;
}

/** Whether the scribble's `turns` fill in the outline `it` (mostly inside its box, mostly right at its path). */
function isShadingInside(it: Item, path: readonly P[], turns: readonly P[]): boolean {
  if (turns.length < SCRIBBLE.minReversals || path.length < 2) return false;
  const b = itemBBox(it);
  const pad = enclosePad(b);
  const within = turns.filter(([x, y]) => x >= b[0] - pad && x <= b[2] + pad && y >= b[1] - pad && y <= b[3] + pad);
  if (within.length < SCRIBBLE.surroundShare * turns.length) return false;
  const near = turns.filter((t) => distToPath(t, path) <= mm(SCRIBBLE.shadeTurnMm)).length;
  return near >= SCRIBBLE.shadeShare * turns.length;
}

/**
 * The scribble's turns (its sharp reversals, as `scribbleShape` finds them) and its legs between them, each without
 * its ends: where a leg turns it may touch the ink around it (shading turns at the outline it fills), but its middle
 * crosses what it rubs out.
 */
function scribbleLegs(raw: readonly P[]): { legs: { x: number; y: number }[][]; turns: P[] } {
  const step = mm(0.4);
  const r = resample(raw, step);
  const k = Math.max(1, Math.round(mm(SCRIBBLE.turnMm) / step));
  const rev = reversals(r, k);
  const legs: { x: number; y: number }[][] = [];
  for (let i = 1; i < rev.length; i++) {
    const a = rev[i - 1]!;
    const b = rev[i]!;
    const trim = Math.round(mm(SCRIBBLE.legTrimMm) / step);
    if (b - trim - (a + trim) < 1) continue;
    legs.push(r.slice(a + trim, b - trim + 1).map(([x, y]) => ({ x, y })));
  }
  return { legs, turns: rev.map((i) => r[i]!) };
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
