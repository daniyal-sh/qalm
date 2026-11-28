import type { InkPoint } from './InkOverlay.types';

/** How far ahead the tip is guessed: about one frame. */
export const PREDICT_MS = 12;
/** Velocity is taken over the real samples of this last stretch of time. */
const WINDOW_MS = 24;

/**
 * Our own prediction for web when samples come from `pointerrawupdate` (which has no predicted events): one point
 * ahead of the last real sample, at its velocity over the last WINDOW_MS, PREDICT_MS ahead and at most `maxLen` long
 * (page units). Only the position is guessed: it keeps the last real pressure, tilt and azimuth. Empty when the pen
 * is still or there is too little to go on.
 */
export function predictTip(points: readonly InkPoint[], maxLen: number): InkPoint[] {
  const last = points[points.length - 1];
  if (!last || points.length < 2) return [];
  let i = points.length - 2;
  while (i > 0 && last.t - points[i - 1]!.t <= WINDOW_MS) i--;
  const from = points[i]!;
  const dt = last.t - from.t;
  if (dt <= 0 || dt > WINDOW_MS) return [];
  let dx = ((last.x - from.x) / dt) * PREDICT_MS;
  let dy = ((last.y - from.y) / dt) * PREDICT_MS;
  const len = Math.hypot(dx, dy);
  if (len === 0) return [];
  if (len > maxLen) {
    dx *= maxLen / len;
    dy *= maxLen / len;
  }
  return [{ ...last, x: last.x + dx, y: last.y + dy, t: last.t + PREDICT_MS }];
}
