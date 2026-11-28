import { describe, expect, it } from 'vitest';

import type { InkPoint } from '../../../modules/qalm-ink/src/InkOverlay.types';
import { PREDICT_MS, predictTip } from '../../../modules/qalm-ink/src/predictTip';

const pt = (x: number, y: number, t: number, p = 0.5): InkPoint => ({ x, y, p, tilt: 1, az: 0.3, t });

describe('predictTip', () => {
  it('guesses one point a frame ahead at the recent velocity', () => {
    // 0.1 units/ms along x, a sample every 4 ms.
    const pts = [0, 4, 8, 12, 16, 20, 24, 28].map((t) => pt(t * 0.1, 5, t));
    const [g] = predictTip(pts, 100);
    expect(g!.x).toBeCloseTo(2.8 + 0.1 * PREDICT_MS);
    expect(g!.y).toBeCloseTo(5);
    expect(g!.t).toBe(28 + PREDICT_MS);
  });

  it('keeps the last real pressure, tilt and azimuth', () => {
    const [g] = predictTip([pt(0, 0, 0, 0.2), pt(1, 1, 4, 0.9)], 100);
    expect(g).toMatchObject({ p: 0.9, tilt: 1, az: 0.3 });
  });

  it('caps the guess to maxLen', () => {
    const [g] = predictTip([pt(0, 0, 0), pt(40, 30, 4)], 2);
    expect(Math.hypot(g!.x - 40, g!.y - 30)).toBeCloseTo(2);
  });

  it('uses only the last stretch, so a turn shows quickly', () => {
    // Long run along x, then the last 24 ms along y.
    const pts = [...[0, 10, 20, 30, 40].map((t) => pt(t, 0, t)), ...[48, 56, 64].map((t) => pt(40, t - 40, t))];
    const [g] = predictTip(pts, 100);
    expect(g!.y).toBeGreaterThan(24);
    expect(Math.abs(g!.x - 40)).toBeLessThan(Math.abs(g!.y - 24));
  });

  it('guesses nothing when still, too new or too old', () => {
    expect(predictTip([pt(1, 1, 0)], 10)).toEqual([]);
    expect(predictTip([pt(1, 1, 0), pt(1, 1, 8)], 10)).toEqual([]);
    expect(predictTip([pt(1, 1, 0), pt(2, 1, 0)], 10)).toEqual([]);
    expect(predictTip([pt(0, 0, 0), pt(5, 0, 100)], 10)).toEqual([]);
  });
});
