// The laser pointer's trail (pure, so it can be tested): which runs of it to draw, at which fade.
import { LASER_FADE_MS } from './InkOverlay.types';

/** A laser trail point: page units, performance.now() ms, and whether it starts a new segment (a new press). */
export interface LaserPt {
  x: number;
  y: number;
  t: number;
  start: boolean;
}

/** The laser's fade in this many steps: each step of a trail is drawn as one path. */
export const LASER_BANDS = 8;

/**
 * The trail as runs to draw, oldest first: consecutive points of one press whose fade (by the newer point's age, at
 * `now`) falls in the same band. Neighbouring runs share their joint point, so the trail stays continuous.
 */
export function laserRuns(pts: readonly LaserPt[], now: number): { pts: LaserPt[]; alpha: number }[] {
  const out: { pts: LaserPt[]; alpha: number }[] = [];
  let cur: { pts: LaserPt[]; alpha: number } | null = null;
  for (let i = 1; i < pts.length; i++) {
    const q = pts[i]!;
    if (q.start) {
      cur = null;
      continue;
    }
    const fade = Math.max(0, 1 - (now - q.t) / LASER_FADE_MS);
    const alpha = Math.ceil(fade * LASER_BANDS) / LASER_BANDS;
    if (alpha <= 0) continue;
    if (!cur || cur.alpha !== alpha) {
      cur = { pts: [pts[i - 1]!], alpha };
      out.push(cur);
    }
    cur.pts.push(q);
  }
  return out;
}
