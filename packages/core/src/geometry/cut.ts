// A partly erased stroke that keeps its id (tech-spec §7, Erasing) is stored as its original points plus a `cut`: the
// fractional point indexes [from, to] it now runs between. Reading the stroke interpolates its two ends and keeps the
// points in between, so each rub of the eraser writes two numbers instead of the whole point array again (which undo
// and sync would keep a copy of), and a concurrent move (which writes `points`) still applies to it.
import type { InkPoint } from '../types';

export type Cut = [from: number, to: number];

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return a + d * t;
}

export function lerpPoint(a: InkPoint, b: InkPoint, t: number): InkPoint {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    p: a.p + (b.p - a.p) * t,
    tilt: a.tilt + (b.tilt - a.tilt) * t,
    az: lerpAngle(a.az, b.az, t),
    t: a.t + (b.t - a.t) * t,
  };
}

/** The point at fractional index `f` (between points ⌊f⌋ and ⌈f⌉). */
function pointAt(pts: readonly InkPoint[], f: number): InkPoint {
  const i = Math.min(pts.length - 1, Math.max(0, Math.floor(f)));
  const t = f - i;
  return t > 0 && i + 1 < pts.length ? lerpPoint(pts[i]!, pts[i + 1]!, t) : pts[i]!;
}

/**
 * The points of `pts` from fractional index `cut[0]` to `cut[1]`: the two ends interpolated, the points in between as
 * they are. `src` is each returned point's (fractional) index in `pts`.
 */
export function cutPoints(pts: readonly InkPoint[], cut: Cut): { points: InkPoint[]; src: number[] } {
  const n = pts.length;
  if (!n) return { points: [], src: [] };
  const a = Math.min(n - 1, Math.max(0, cut[0]));
  const b = Math.min(n - 1, Math.max(a, cut[1]));
  const points = [pointAt(pts, a)];
  const src = [a];
  for (let i = Math.floor(a) + 1; i < b; i++) {
    points.push(pts[i]!);
    src.push(i);
  }
  if (b > a) {
    points.push(pointAt(pts, b));
    src.push(b);
  }
  return { points, src };
}

/** A range in the coordinates of `cutPoints(…).points`, mapped back to the original points' indexes (`src`). */
export function composeCut(src: readonly number[], keep: Cut): Cut {
  const at = (f: number) => {
    if (src.length < 2) return src[0] ?? 0;
    const k = Math.min(src.length - 2, Math.max(0, Math.floor(f)));
    return src[k]! + (src[k + 1]! - src[k]!) * (f - k);
  };
  return [at(keep[0]), at(keep[1])];
}
