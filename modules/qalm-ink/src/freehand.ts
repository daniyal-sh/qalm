import { getStroke } from 'perfect-freehand';

import type { InkPoint } from './InkOverlay.types';

/**
 * The live-stroke outline used by the web overlay. These are exactly the tech-spec §2 settings that
 * `strokeOutline` in `@qalm/core` uses, so the hand-off to PageCanvas is invisible.
 * The Android port (QalmFreehand.kt) uses the same constants.
 */
export const tiltPressure = (pt: InkPoint) =>
  Math.min(1, pt.p * (1 + 0.6 * (1 - pt.tilt / (Math.PI / 2))));

export function liveOutline(
  tool: 'pen' | 'highlighter',
  width: number,
  pts: InkPoint[],
): number[][] {
  if (tool === 'highlighter') {
    return getStroke(
      pts.map((q) => [q.x, q.y, 0.5]),
      { size: width, thinning: 0, smoothing: 0.5, streamline: 0.5, simulatePressure: false, last: true },
    );
  }
  return getStroke(
    pts.map((q) => [q.x, q.y, tiltPressure(q)]),
    { size: width, thinning: 0.6, smoothing: 0.5, streamline: 0.35, simulatePressure: false, last: true },
  );
}

export const HIGHLIGHTER_ALPHA = 0.45;
