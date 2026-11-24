// The ruler's moves (pure): drag with one finger or the mouse, turn and move with two fingers, turn with the handle.
// Poses are in the same screen px as the pointers (the Ruler converts between the editor's view and the window).
// Angles snap to 0 / 45 / 90° (`snapRulerAngle`, RULER.snapDeg) and are kept in [0, 2π).
import { RULER, snapRulerAngle, type RulerPose } from '@qalm/core';

export interface Pt {
  x: number;
  y: number;
}

/** A new ruler: horizontal, centred in the view, as long as RULER.length but never wider than the view allows. */
export function defaultRuler(view: { w: number; h: number }): RulerPose {
  const length = Math.round(Math.max(200, Math.min(RULER.length, view.w - 48)));
  return { cx: view.w / 2, cy: view.h / 2, angle: 0, length, thickness: RULER.thickness };
}

/** One pointer moved the ruler's body from `from` to `to`. */
export function dragRuler(start: RulerPose, from: Pt, to: Pt): RulerPose {
  return { ...start, cx: start.cx + to.x - from.x, cy: start.cy + to.y - from.y };
}

/** The signed difference b − a, in (−π, π]. */
function turn(a: number, b: number): number {
  let d = (b - a) % (2 * Math.PI);
  if (d <= -Math.PI) d += 2 * Math.PI;
  if (d > Math.PI) d -= 2 * Math.PI;
  return d;
}

/**
 * Two fingers went from (a0, b0) to (a1, b1): the ruler moves with their midpoint and turns with the line between them
 * (snapped), about that midpoint, so the ruler stays under the fingers.
 */
export function twoFingerRuler(start: RulerPose, a0: Pt, b0: Pt, a1: Pt, b1: Pt): RulerPose {
  const m0 = { x: (a0.x + b0.x) / 2, y: (a0.y + b0.y) / 2 };
  const m1 = { x: (a1.x + b1.x) / 2, y: (a1.y + b1.y) / 2 };
  const raw = Math.atan2(b1.y - a1.y, b1.x - a1.x) - Math.atan2(b0.y - a0.y, b0.x - a0.x);
  const angle = snapRulerAngle(start.angle + raw);
  const d = turn(start.angle, angle);
  const cos = Math.cos(d);
  const sin = Math.sin(d);
  const rx = start.cx - m0.x;
  const ry = start.cy - m0.y;
  return { ...start, angle, cx: m1.x + rx * cos - ry * sin, cy: m1.y + rx * sin + ry * cos };
}

/** The rotate handle (mouse) dragged from `from` to `to`: the ruler turns about its centre (snapped). */
export function rotateRuler(start: RulerPose, from: Pt, to: Pt): RulerPose {
  const d = Math.atan2(to.y - start.cy, to.x - start.cx) - Math.atan2(from.y - start.cy, from.x - start.cx);
  return { ...start, angle: snapRulerAngle(start.angle + d) };
}

/** Keeps the ruler's centre inside the view (minus `margin`), so it can't be lost off screen. */
export function keepInView(r: RulerPose, view: { w: number; h: number }, margin = 24): RulerPose {
  const cx = Math.min(Math.max(r.cx, margin), Math.max(margin, view.w - margin));
  const cy = Math.min(Math.max(r.cy, margin), Math.max(margin, view.h - margin));
  return cx === r.cx && cy === r.cy ? r : { ...r, cx, cy };
}

export interface Tick {
  /** px from the ruler's zero */
  x: number;
  kind: 'mm' | 'half' | 'cm';
  /** cm number, on cm ticks */
  label?: number;
}

/** Below this many px per mm, mm ticks are left out (they'd be a grey smear); 5 mm and cm ticks stay. */
export const MIN_MM_TICK_PX = 3;

/** The ticks along `lengthPx` of ruler at `pxPerMm` (page mm at the current zoom), from zero. */
export function rulerTicks(lengthPx: number, pxPerMm: number): Tick[] {
  if (!(pxPerMm > 0) || !(lengthPx > 0)) return [];
  const out: Tick[] = [];
  const mm = Math.floor(lengthPx / pxPerMm);
  const fine = pxPerMm >= MIN_MM_TICK_PX;
  for (let i = 0; i <= mm; i++) {
    const kind = i % 10 === 0 ? 'cm' : i % 5 === 0 ? 'half' : 'mm';
    if (kind === 'mm' && !fine) continue;
    out.push(kind === 'cm' ? { x: i * pxPerMm, kind, label: i / 10 } : { x: i * pxPerMm, kind });
  }
  return out;
}
