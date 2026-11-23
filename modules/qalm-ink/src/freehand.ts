import { strokeOutline, type PenStyle, type Smoothing } from '@qalm/core';

import type { InkPoint } from './InkOverlay.types';

/**
 * The live-stroke outline used by the web overlay: @qalm/core `strokeOutline` itself (tech-spec §2), so the
 * hand-off to PageCanvas is invisible. The Android (QalmFreehand.kt) and iOS (Freehand.swift) ports match it.
 */
export function liveOutline(
  tool: 'pen' | 'highlighter',
  width: number,
  pts: InkPoint[],
  style?: PenStyle,
  smoothing?: Smoothing,
): number[][] {
  return strokeOutline({ tool, width, points: pts, style, smoothing });
}

export const HIGHLIGHTER_ALPHA = 0.45;
