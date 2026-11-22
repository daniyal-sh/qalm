import type { StyleProp, ViewStyle } from 'react-native';

/**
 * One sampled input point in page units. Structurally identical to `InkPoint` in `@qalm/core`
 * (tech-spec §2); declared here so the overlay does not depend on core.
 */
export interface InkPoint {
  x: number;
  y: number;
  /** 0..1 */
  p: number;
  /** altitude in radians, π/2 = upright */
  tilt: number;
  /** azimuth in radians */
  az: number;
  /** ms since stroke start */
  t: number;
}

export type InkTool = 'pen' | 'highlighter' | 'eraser' | 'lasso' | 'none';

export interface InkInputSettings {
  drawWith: 'pen' | 'any';
  hand: 'left' | 'right';
  palm: 'relaxed' | 'standard' | 'strict';
}

export interface StrokeEndEvent {
  id: string;
  tool: 'pen' | 'highlighter';
  color: string;
  width: number;
  points: InkPoint[];
  heldMs: number;
}
export interface EraseEvent {
  path: { x: number; y: number }[];
}
export interface LassoEvent {
  polygon: { x: number; y: number }[];
}
export interface PenButtonEvent {
  kind: 'double-tap' | 'squeeze' | 'button';
}
export interface RejectedTouchEvent {
  reason: string;
}

export interface InkOverlayProps {
  /** page units; the overlay's laid-out size maps linearly onto the page */
  pageSize: { w: number; h: number };
  tool: InkTool;
  color: string;
  /** page units */
  width: number;
  input: InkInputSettings;
  /** stroke ids already drawn by PageCanvas */
  committedIds: string[];
  onStrokeEnd(e: { nativeEvent: StrokeEndEvent }): void;
  /** Emitted while erasing: each event carries the path segment since the previous event (page units). */
  onErase(e: { nativeEvent: EraseEvent }): void;
  onLasso(e: { nativeEvent: LassoEvent }): void;
  onPenButton?(e: { nativeEvent: PenButtonEvent }): void;
  onRejectedTouch?(e: { nativeEvent: RejectedTouchEvent }): void;
  /** Layout. Defaults to absolute fill of the parent (stack it exactly over the PageCanvas). */
  style?: StyleProp<ViewStyle>;
}

/** Palm rejection constants (tech-spec §3). Shared by every overlay implementation. */
export const PALM_MAJOR_MM = { relaxed: 9, standard: 7, strict: 5 } as const;
export const PEN_LOCKOUT_MS = 600;
