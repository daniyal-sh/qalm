// Ruler moves and ticks, the presentation fit, and the focus pill folding its extra tools (laser, ruler) on a phone.
import { RULER, type RulerPose } from '@qalm/core';
import { describe, expect, it } from 'vitest';

import { DEFAULT_PILL, pillCompact, PILL_MARGIN, PILL_MIN_SCALE } from '../src/editor/focus.logic';
import { defaultRuler, dragRuler, keepInView, MIN_MM_TICK_PX, rotateRuler, rulerTicks, twoFingerRuler } from '../src/editor/ruler.logic';
import { centredScroll, fitZoom, layoutPages } from '../src/editor/view';

const deg = (d: number) => (d * Math.PI) / 180;
const r0: RulerPose = { cx: 400, cy: 300, angle: 0, length: 600, thickness: 72 };

describe('ruler moves', () => {
  it('starts horizontal, centred, no wider than the view', () => {
    expect(defaultRuler({ w: 1200, h: 800 })).toEqual({ cx: 600, cy: 400, angle: 0, length: RULER.length, thickness: RULER.thickness });
    expect(defaultRuler({ w: 390, h: 800 }).length).toBe(342);
  });

  it('one finger or the mouse drags it', () => {
    expect(dragRuler(r0, { x: 10, y: 10 }, { x: 40, y: -10 })).toMatchObject({ cx: 430, cy: 280, angle: 0 });
  });

  it('two fingers turn it about their midpoint and move it with them', () => {
    // Fingers on the ruler at 300 and 500, turned by 30° about their midpoint (the centre) and moved 50 px down.
    const a1 = { x: 400 - 100 * Math.cos(deg(30)), y: 350 - 100 * Math.sin(deg(30)) };
    const b1 = { x: 400 + 100 * Math.cos(deg(30)), y: 350 + 100 * Math.sin(deg(30)) };
    const r = twoFingerRuler(r0, { x: 300, y: 300 }, { x: 500, y: 300 }, a1, b1);
    expect(r.angle).toBeCloseTo(deg(30));
    expect(r.cx).toBeCloseTo(400);
    expect(r.cy).toBeCloseTo(350);
  });

  it('two fingers off-centre keep the ruler under them as it turns', () => {
    // Fingers at the right end; a quarter turn about them swings the centre round.
    const r = twoFingerRuler(r0, { x: 600, y: 300 }, { x: 700, y: 300 }, { x: 650, y: 250 }, { x: 650, y: 350 });
    expect(r.angle).toBeCloseTo(deg(90));
    expect(r.cx).toBeCloseTo(650);
    expect(r.cy).toBeCloseTo(50);
  });

  it('snaps to 0 / 45 / 90° within a few degrees', () => {
    const near = twoFingerRuler(r0, { x: 300, y: 300 }, { x: 500, y: 300 }, { x: 300, y: 300 }, { x: 500, y: 300 + 200 * Math.tan(deg(3)) });
    expect(near.angle).toBeCloseTo(0);
    const at44 = rotateRuler(r0, { x: 700, y: 300 }, { x: 400 + 300 * Math.cos(deg(44)), y: 300 + 300 * Math.sin(deg(44)) });
    expect(at44.angle).toBeCloseTo(deg(45));
    const at30 = rotateRuler(r0, { x: 700, y: 300 }, { x: 400 + 300 * Math.cos(deg(30)), y: 300 + 300 * Math.sin(deg(30)) });
    expect(at30.angle).toBeCloseTo(deg(30));
  });

  it('stays on screen', () => {
    expect(keepInView({ ...r0, cx: -500, cy: 5000 }, { w: 800, h: 600 })).toMatchObject({ cx: 24, cy: 576 });
    expect(keepInView(r0, { w: 800, h: 600 })).toBe(r0);
  });
});

describe('ruler ticks', () => {
  it('mm, 5 mm and numbered cm ticks at the page scale', () => {
    const t = rulerTicks(100, 4); // 25 mm
    expect(t).toHaveLength(26);
    expect(t[0]).toEqual({ x: 0, kind: 'cm', label: 0 });
    expect(t[5]).toEqual({ x: 20, kind: 'half' });
    expect(t[10]).toEqual({ x: 40, kind: 'cm', label: 1 });
    expect(t[1]!.kind).toBe('mm');
  });
  it('leaves out mm ticks when they would smear', () => {
    const t = rulerTicks(100, MIN_MM_TICK_PX - 0.5);
    expect(t.every((x) => x.kind !== 'mm')).toBe(true);
    expect(t.filter((x) => x.kind === 'cm')).toHaveLength(5); // 40 mm: 0 to 4 cm
  });
});

describe('presentation fit', () => {
  const a4 = { size: { w: 595, h: 842 } };
  it('fits a page whole, below the usual minimum zoom when it must', () => {
    // 1280×800: base 900; an A4 page 900 px wide at zoom 1 would be 1274 px tall.
    const z = fitZoom(a4, 595, 900, { w: 1280, h: 800 });
    expect(z).toBeCloseTo((800 - 48) / (900 * (842 / 595)));
    expect(z).toBeLessThan(0.75);
    const slot = layoutPages([{ id: 'p', ...a4 }], 900, z)[0]!;
    expect(slot.height).toBeLessThanOrEqual(800 - 48 + 1);
  });
  it('a landscape page on a tall screen fits by width', () => {
    const z = fitZoom({ size: { w: 842, h: 595 } }, 842, 342, { w: 390, h: 800 });
    expect(z).toBeCloseTo((390 - 48) / 342);
  });
  it('centres the page vertically', () => {
    expect(centredScroll({ top: 1000, height: 700 }, 800)).toBe(950);
    expect(centredScroll({ top: 24, height: 700 }, 800)).toBe(0);
  });
});

describe('focus pill on a phone', () => {
  it('folds the laser and ruler into More tools only when they would not fit', () => {
    const room = 390 - 2 * PILL_MARGIN;
    expect(pillCompact(DEFAULT_PILL, { w: 1200, h: 800 }, 520)).toBe(false);
    expect(pillCompact(DEFAULT_PILL, { w: 390, h: 800 }, room / PILL_MIN_SCALE + 1)).toBe(true);
    expect(pillCompact(DEFAULT_PILL, { w: 390, h: 800 }, room / PILL_MIN_SCALE - 1)).toBe(false);
    // On a side edge the room is the height.
    expect(pillCompact({ edge: 'left', along: 0.5 }, { w: 390, h: 800 }, 520)).toBe(false);
  });
});
