// Palm rejection rules for a touch contact (tech-spec §3), as a pure function so they can be unit-tested. The web
// overlay uses it for pointer events (does the touch draw?) and for touch events (may the browser scroll with it?).
import { PALM_MAJOR_MM, PEN_LOCKOUT_MS, type InkInputSettings } from './InkOverlay.types';

/** CSS px → mm (tech-spec §3: web CSS px = 0.2646 mm). */
export const MM_PER_CSS_PX = 0.2646;
/** A touch on the hand side of the pen is rejected while the pen was seen within this window. */
export const HAND_SIDE_WINDOW_MS = 2000; // same as iOS and Android
/** "Beside or below" = no more than this far on the other side of / above the pen tip. */
export const HAND_SIDE_MARGIN_MM = 10;

/** Where and when the pen was last seen (touching or hovering): client px, ms on the event clock. */
export interface PenSeen {
  x: number;
  y: number;
  t: number;
}

/** A touch contact: client px, ms on the event clock, and the full length of its major axis in CSS px. */
export interface Contact {
  x: number;
  y: number;
  t: number;
  majorPx: number;
}

export type PalmReason = 'palm-size' | 'pen-lockout' | 'hand-side';

/**
 * Why this touch is a palm (or a hand resting near the pen), or null for a finger. Checked in this order: contact size,
 * the 600 ms pen lockout, then the writing hand's side of the pen for 2 s.
 */
export function palmVerdict(c: Contact, pen: PenSeen, input: Pick<InkInputSettings, 'hand' | 'palm'>, mmPerPx = MM_PER_CSS_PX): PalmReason | null {
  if (c.majorPx * mmPerPx > PALM_MAJOR_MM[input.palm]) return 'palm-size';
  const since = c.t - pen.t;
  if (since < PEN_LOCKOUT_MS) return 'pen-lockout';
  if (since <= HAND_SIDE_WINDOW_MS) {
    const margin = HAND_SIDE_MARGIN_MM / mmPerPx;
    const dx = c.x - pen.x;
    const dy = c.y - pen.y;
    const beside = input.hand === 'right' ? dx > -margin : dx < margin;
    if (beside && dy > -margin) return 'hand-side';
  }
  return null;
}

/**
 * "Pen and finger": a second finger turns a finger stroke into a pan or pinch. Landing within this of the first
 * finger, or before the first has travelled SECOND_FINGER_RETRACT_MM, both were meant as the gesture: the stroke is
 * retracted. Later, the stroke was real: it is kept and ends there. Same on iOS and Android.
 */
export const SECOND_FINGER_RETRACT_MS = 150;
export const SECOND_FINGER_RETRACT_MM = 3;

/** Whether a second finger retracts the stroke the first one is drawing (else the stroke is kept). */
export const secondFingerRetracts = (sinceFirstMs: number, travelMm: number) =>
  sinceFirstMs < SECOND_FINGER_RETRACT_MS || travelMm < SECOND_FINGER_RETRACT_MM;

/** A PointerEvent's contact: `width`/`height` are the contact's full size in CSS px. */
export const pointerContact = (ev: PointerEvent): Contact => ({ x: ev.clientX, y: ev.clientY, t: ev.timeStamp, majorPx: Math.max(ev.width, ev.height) });

/** A Touch's contact: `radiusX`/`radiusY` are half the contact's size in CSS px. */
export const touchContact = (t: Touch, timeStamp: number): Contact => ({
  x: t.clientX,
  y: t.clientY,
  t: timeStamp,
  majorPx: 2 * Math.max(t.radiusX || 0, t.radiusY || 0),
});
