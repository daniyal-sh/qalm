import { describe, expect, it } from 'vitest';

import { PALM_MAJOR_MM, PEN_LOCKOUT_MS } from '../../../modules/qalm-ink/src/InkOverlay.types';
import { MM_PER_CSS_PX, palmVerdict, type Contact, type PenSeen } from '../../../modules/qalm-ink/src/palm';
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
    expect(palmVerdict(touch(25), NO_PEN, right)).toBe('palm-size'); // a palm
    expect(palmVerdict(touch(8), NO_PEN, { hand: 'right', palm: 'relaxed' })).toBeNull(); // a finger, relaxed
    expect(palmVerdict(touch(8), NO_PEN, right)).toBe('palm-size'); // the same finger, standard
  });

  it('uses the full major axis', () => {
    // 6.5 mm across is a finger at standard (7 mm); its 3.25 mm radius must not be doubled again or halved.
    expect(palmVerdict(touch(6.5), NO_PEN, right)).toBeNull();
    expect(palmVerdict(touch(7.5), NO_PEN, right)).toBe('palm-size');
  });

  it('locks touches out for 600 ms after the pen, anywhere on the page', () => {
    const pen: PenSeen = { x: 500, y: 500, t: 10_000 };
    const farLeftAbove = { x: 100, y: 100 };
    expect(palmVerdict(touch(5, { ...farLeftAbove, t: 10_000 + PEN_LOCKOUT_MS - 1 }), pen, right)).toBe('pen-lockout');
    expect(palmVerdict(touch(5, { ...farLeftAbove, t: 10_000 + PEN_LOCKOUT_MS + 1 }), pen, right)).toBeNull();
  });

  it('rejects touches beside or below the pen on the writing hand side for 3 s', () => {
    const pen: PenSeen = { x: 500, y: 500, t: 10_000 };
    const t = 10_000 + 1000;
    // Right hand: right of the pen, or below it.
    expect(palmVerdict(touch(5, { x: 600, y: 520, t }), pen, right)).toBe('hand-side');
    expect(palmVerdict(touch(5, { x: 480, y: 700, t }), pen, right)).toBe('hand-side'); // within 10 mm left, below
    expect(palmVerdict(touch(5, { x: 500 - px(11), y: 700, t }), pen, right)).toBeNull(); // further left
    expect(palmVerdict(touch(5, { x: 600, y: 500 - px(11), t }), pen, right)).toBeNull(); // above the pen
    // Left hand mirrors it.
    expect(palmVerdict(touch(5, { x: 400, y: 520, t }), pen, { hand: 'left', palm: 'standard' })).toBe('hand-side');
    expect(palmVerdict(touch(5, { x: 600, y: 520, t }), pen, { hand: 'left', palm: 'standard' })).toBeNull();
    // After 3 s the side doesn't matter.
    expect(palmVerdict(touch(5, { x: 600, y: 520, t: 10_000 + 3001 }), pen, right)).toBeNull();
  });

  it('checks size first, so a palm says so even right after the pen', () => {
    expect(palmVerdict(touch(25, { t: 10_010 }), { x: 500, y: 500, t: 10_000 }, right)).toBe('palm-size');
  });

  it('has words for every reason the overlay reports', () => {
    for (const r of ['pen-only', 'palm-size', 'pen-lockout', 'hand-side', 'pen-active', 'pen-took-over', 'multi-touch', 'cancelled']) {
      expect(rejectedTouchText(r)).not.toBe('Ignored that touch');
    }
  });
});
