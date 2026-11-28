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

export type InkTool = 'pen' | 'highlighter' | 'eraser' | 'lasso' | 'laser' | 'none';

/**
 * The on-screen ruler (same shape as `RulerPose` in @qalm/core), in window coordinates: CSS px on web, dp on Android,
 * points on iOS. The overlay converts it to its page with its own position in the window.
 */
export interface InkRuler {
  cx: number;
  cy: number;
  /** radians, clockwise */
  angle: number;
  length: number;
  thickness: number;
}
/** Same as PenStyle / Smoothing in @qalm/core (tech-spec §2). */
export type InkPenStyle = 'fountain' | 'ball' | 'brush';
export type InkSmoothing = 0 | 1 | 2 | 3;

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
  /** pen strokes: the style and smoothing the overlay drew with; store them on the StrokeItem */
  style: InkPenStyle;
  smoothing: InkSmoothing;
  /**
   * Set when the stroke snapped to a shape while the pen was held (and was then adjusted and lifted): the shape to
   * store. `points` is still the hand-drawn stroke up to the snap (for undo). The overlay hands it off under `id`.
   */
  shape?: { kind: string; pts: [number, number][] };
  /** Ruled along the ruler (its points lie on one line): never a scribble. */
  ruler?: boolean;
}

/**
 * A recognised shape while the pen is still down (from `recognizeShape`): what to store (`kind`, `pts`, as
 * `ShapeItem` in @qalm/core) and its outline to draw (`polylines`, page units).
 */
export interface ShapePreview {
  kind: string;
  pts: [number, number][];
  polylines: [number, number][][];
}
export interface EraseEvent {
  path: { x: number; y: number }[];
  /** The pen (or finger, mouse) lifted: this is the gesture's last segment (the app bakes a partial erase then). */
  final?: boolean;
}
export interface LassoEvent {
  /**
   * Every point of the lasso drag (page units), also for a tap (1 or 2 points): the app treats a lasso that hardly
   * moved as a tap. With `lassoMode: 'rect'` the rectangle runs from the first point to the last.
   */
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
  /** pen only; default 'fountain' */
  penStyle?: InkPenStyle;
  /** pen only; default 0 (none) */
  smoothing?: InkSmoothing;
  /**
   * eraser only: 'partial' (the app splits strokes where it passes) also shows a faint trail of the eraser's last
   * ERASE_TRAIL_MS under the pen, while the page catches up. Default 'stroke'.
   */
  eraserMode?: 'stroke' | 'partial';
  /**
   * While set (the ruler is shown), a pen or highlighter stroke that starts within RULER_SNAP_PX outside one of its long
   * edges (or over its half next to that edge) is drawn straight along that edge: each point is projected onto the
   * edge line, pushed out by half the pen width, keeping its pressure. Such a stroke never snaps to a shape.
   */
  ruler?: InkRuler | null;
  /**
   * Web only: the ruler as it is right now, read when a stroke starts (a finger may be moving it; `ruler` only
   * changes once its pose settles). Takes precedence over `ruler`.
   */
  getRuler?(): InkRuler | null;
  /**
   * laser only: 'trail' (default) leaves a glowing red trail that fades over LASER_FADE_MS; 'dot' shows one point
   * that follows the pen (and a hovering pen or mouse). The laser never emits strokes: nothing is saved.
   */
  laserMode?: 'trail' | 'dot';
  /** lasso only: a freeform loop (default) or a rectangle from where the drag started to where it is now */
  lassoMode?: 'free' | 'rect';
  input: InkInputSettings;
  /**
   * Stroke ids already drawn by PageCanvas: pass the newest ids from PageCanvas's `onDrawn`, not the page's items (Skia
   * shows new items a few frames after React commits them). A finished stroke stays a short hand-off after its id arrives.
   */
  committedIds: string[];
  /**
   * A stroke began (any tool). Android only: the app holds page redraws while the pen keeps writing, since Skia
   * redraws the page on the UI thread that pen input arrives on (tech-spec §3).
   */
  onStrokeStart?(e: { nativeEvent: Record<string, never> }): void;
  onStrokeEnd(e: { nativeEvent: StrokeEndEvent }): void;
  /** Emitted while erasing: each event carries the path segment since the previous event (page units). */
  onErase(e: { nativeEvent: EraseEvent }): void;
  onLasso(e: { nativeEvent: LassoEvent }): void;
  onPenButton?(e: { nativeEvent: PenButtonEvent }): void;
  onRejectedTouch?(e: { nativeEvent: RejectedTouchEvent }): void;
  /**
   * Live shapes (pen only). When the pen holds still (`SHAPE_HOLD_MS` within `SHAPE_HOLD_MM` of where the hold began)
   * the overlay asks this for the shape the stroke so far looks like (the points up to where the hold began). A
   * shape replaces the ink under the pen at once (haptic tick on native, a pulse on web); null changes nothing and
   * the pen keeps drawing. Leave it out to turn live shapes off. On native it is called asynchronously, once per
   * hold: the hold itself is the latency budget, and a reply that arrives after the pen moved on or lifted is dropped.
   */
  recognizeShape?(points: { x: number; y: number }[]): ShapePreview | null;
  /**
   * Dragging after the snap (web only; the native overlays carry a port of @qalm/core `adjustShape`): the shape for the
   * pen now at `to`, given it was at `from` when it snapped. Without it the shape stays as recognised.
   */
  adjustShape?(shape: ShapePreview, from: [number, number], to: [number, number]): ShapePreview;
  /**
   * The first real pen this overlay sees, touching or hovering (web pointerType 'pen', Android TOOL_TYPE_STYLUS,
   * iOS `.pencil`). Fires once per overlay; the app remembers it to auto-pick `input.drawWith`.
   */
  onPenSeen?(e: { nativeEvent: Record<string, never> }): void;
  /** Layout. Defaults to absolute fill of the parent (stack it exactly over the PageCanvas). */
  style?: StyleProp<ViewStyle>;
}

/** Palm rejection constants (tech-spec §3). Shared by every overlay implementation. */
export const PALM_MAJOR_MM = { relaxed: 30, standard: 20, strict: 14 } as const;
export const PEN_LOCKOUT_MS = 600;
/** Ruler snapping: a stroke starting this far (window px / dp / pt) outside a ruler edge follows it (core RULER.snapPx). */
export const RULER_SNAP_PX = 24;
/** The laser's trail fades out over this long (ms). */
export const LASER_FADE_MS = 1000;
/** Laser colours: brand `bad` (#b91c1c) for the core and its dark-theme tint (#f87171) for the glow. */
export const LASER_CORE = '#b91c1c';
export const LASER_GLOW = '#f87171';
/** Partial erase: the trail under the eraser covers its last this many ms. */
export const ERASE_TRAIL_MS = 250;
/** Live shapes: hold this long (ms) … */
export const SHAPE_HOLD_MS = 400;
/** … within this distance (mm) of where the hold began (core: SNAP_HOLD_MS / SNAP_HOLD_TOLERANCE_MM). */
export const SHAPE_HOLD_MM = 2.5;
