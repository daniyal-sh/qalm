import { describe, expect, it } from 'vitest';

import { PALM_MAJOR_MM, PEN_LOCKOUT_MS } from '../../../modules/qalm-ink/src/InkOverlay.types';
import { HAND_SIDE_WINDOW_MS, MM_PER_CSS_PX, palmVerdict, SECOND_FINGER_RETRACT_MM, SECOND_FINGER_RETRACT_MS, secondFingerRetracts, type Contact, type PenSeen } from '../../../modules/qalm-ink/src/palm';
import { flingStep, flingVelocity } from '../../../modules/qalm-ink/src/twoFingerPan';
import { rejectedTouchText } from '../src/lib/palm';

const px = (mm: number) => mm / MM_PER_CSS_PX;
const NO_PEN: PenSeen = { x: 0, y: 0, t: -Infinity };
const touch = (mm: number, at: Partial<Contact> = {}): Contact => ({ x: 500, y: 500, t: 10_000, majorPx: px(mm), ...at });
const right = { hand: 'right', palm: 'standard' } as const;

describe('palm rejection (tech-spec §3)', () => {
  it('rejects contacts wider than the threshold, per setting', () => {
    for (const palm of ['relaxed', 'standard', 'strict'] as const) {
      const limit = PALM_MAJOR_MM[palm];
      expect(palmVerdict(touch(limit - 0.5), NO_PEN, { hand: 'right', palm })).toBeNull();
      expect(palmVerdict(touch(limit + 0.5), NO_PEN, { hand: 'right', palm })).toBe('palm-size');
    }
    expect(PALM_MAJOR_MM).toEqual({ relaxed: 30, standard: 20, strict: 14 });
  });

  it('lets fingertips draw, rejects palms at standard and a flat finger or palm edge only at strict', () => {
    const at = (mm: number, palm: 'relaxed' | 'standard' | 'strict') => palmVerdict(touch(mm), NO_PEN, { hand: 'right', palm });
    for (const palm of ['relaxed', 'standard', 'strict'] as const) for (const mm of [7, 8, 10, 12]) expect(at(mm, palm)).toBeNull();
    for (const mm of [22, 25, 30, 40]) expect(at(mm, 'standard')).toBe('palm-size');
    for (const mm of [32, 40]) expect(at(mm, 'relaxed')).toBe('palm-size');
    expect(at(25, 'relaxed')).toBeNull(); // relaxed lets a big contact through; the lockout and hand side still apply
    for (const mm of [15, 16.5, 18]) {
      expect(at(mm, 'strict')).toBe('palm-size');
      expect(at(mm, 'standard')).toBeNull();
      expect(at(mm, 'relaxed')).toBeNull();
    }
  });

  it('uses the full major axis', () => {
    // 19 mm across is a finger at standard (20 mm); its 9.5 mm radius must not be doubled again or halved.
    expect(palmVerdict(touch(19), NO_PEN, right)).toBeNull();
    expect(palmVerdict(touch(21), NO_PEN, right)).toBe('palm-size');
  });

  it('locks touches out for 600 ms after the pen, anywhere on the page', () => {
    const pen: PenSeen = { x: 500, y: 500, t: 10_000 };
    const farLeftAbove = { x: 100, y: 100 };
    expect(palmVerdict(touch(9, { ...farLeftAbove, t: 10_000 + PEN_LOCKOUT_MS - 1 }), pen, right)).toBe('pen-lockout');
    expect(palmVerdict(touch(9, { ...farLeftAbove, t: 10_000 + PEN_LOCKOUT_MS + 1 }), pen, right)).toBeNull();
  });

  it('rejects touches beside or below the pen on the writing hand side for 2 s', () => {
    expect(HAND_SIDE_WINDOW_MS).toBe(2000);
    const pen: PenSeen = { x: 500, y: 500, t: 10_000 };
    const t = 10_000 + 1000;
    // Right hand: right of the pen, or below it.
    expect(palmVerdict(touch(9, { x: 600, y: 520, t }), pen, right)).toBe('hand-side');
    expect(palmVerdict(touch(9, { x: 480, y: 700, t }), pen, right)).toBe('hand-side'); // within 10 mm left, below
    expect(palmVerdict(touch(9, { x: 500 - px(11), y: 700, t }), pen, right)).toBeNull(); // further left
    expect(palmVerdict(touch(9, { x: 600, y: 500 - px(11), t }), pen, right)).toBeNull(); // above the pen
    // Left hand mirrors it.
    expect(palmVerdict(touch(9, { x: 400, y: 520, t }), pen, { hand: 'left', palm: 'standard' })).toBe('hand-side');
    expect(palmVerdict(touch(9, { x: 600, y: 520, t }), pen, { hand: 'left', palm: 'standard' })).toBeNull();
    expect(palmVerdict(touch(9, { x: 600, y: 520, t: 10_000 + 1990 }), pen, right)).toBe('hand-side');
    // After 2 s the side doesn't matter.
    expect(palmVerdict(touch(9, { x: 600, y: 520, t: 10_000 + 2001 }), pen, right)).toBeNull();
  });

  it('checks size first, so a palm says so even right after the pen', () => {
    expect(palmVerdict(touch(25, { t: 10_010 }), { x: 500, y: 500, t: 10_000 }, right)).toBe('palm-size');
  });

  it('retracts a stroke a second finger lands on only while it has just started', () => {
    expect([SECOND_FINGER_RETRACT_MS, SECOND_FINGER_RETRACT_MM]).toEqual([150, 3]);
    expect(secondFingerRetracts(100, 20)).toBe(true); // both fingers landed together
    expect(secondFingerRetracts(800, 1)).toBe(true); // one finger rested, then the other came for a pinch
    expect(secondFingerRetracts(400, 15)).toBe(false); // a real stroke: kept
  });

  it('flings with the fingers’ last velocity, decaying like a native scroll', () => {
    const samples = [0, 20, 40, 60, 80, 100, 120].map((t) => ({ x: 0, y: -t, t }));
    expect(flingVelocity(samples, 125)).toEqual({ vx: 0, vy: -1 });
    expect(flingVelocity(samples, 300)).toEqual({ vx: 0, vy: 0 }); // stood still before lifting
    const s = flingStep(1, 16);
    expect(s.v).toBeCloseTo(Math.pow(0.998, 16));
    expect(s.d).toBeGreaterThan(15);
    expect(s.d).toBeLessThan(16);
  });

  it('has words for every reason the overlay reports', () => {
    for (const r of ['pen-only', 'palm-size', 'pen-lockout', 'hand-side', 'pen-active', 'pen-took-over', 'multi-touch', 'cancelled']) {
      expect(rejectedTouchText(r)).not.toBe('Ignored that touch');
    }
  });
});
