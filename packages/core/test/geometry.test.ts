import { describe, expect, it } from 'vitest';
import { getStroke } from 'perfect-freehand';
import { hitTestErase, lassoSelect, paperPattern, snapShape, stabilize, strokeOutline, strokeSvgPath, tiltPressure } from '../src';
import type { InkPoint, Item, ShapeItem } from '../src';
import { pts, stroke } from './helpers';

function circle(cx: number, cy: number, rx: number, ry: number, n = 60): InkPoint[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = (i / n) * Math.PI * 2;
    return { x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t), p: 0.5, tilt: Math.PI / 2, az: 0, t: i * 8 };
  });
}

describe('stroke geometry', () => {
  it('uses the pinned perfect-freehand settings', () => {
    const s = stroke('s', 0, 0, 100, 40);
    const tilted = { ...s, points: s.points.map((q) => ({ ...q, tilt: 0.5 })) };
    const expected = getStroke(
      tilted.points.map((q) => [q.x, q.y, tiltPressure(q)]),
      { size: 1.8, thinning: 0.6, smoothing: 0.5, streamline: 0.35, simulatePressure: false, last: true },
    );
    expect(strokeOutline(tilted)).toEqual(expected.map((p) => [p[0], p[1]]));
    const hl = { ...s, tool: 'highlighter' as const, width: 12 };
    const hlExpected = getStroke(hl.points.map((q) => [q.x, q.y, 0.5]), { size: 12, thinning: 0, smoothing: 0.5, streamline: 0.5, simulatePressure: false, last: true });
    expect(strokeOutline(hl)).toEqual(hlExpected.map((p) => [p[0], p[1]]));
  });

  it('tilt shading increases pressure when tilted, capped at 1', () => {
    const q = { x: 0, y: 0, p: 0.5, tilt: Math.PI / 2, az: 0, t: 0 };
    expect(tiltPressure(q)).toBe(0.5);
    expect(tiltPressure({ ...q, tilt: 0 })).toBeCloseTo(0.8);
    expect(tiltPressure({ ...q, p: 0.9, tilt: 0 })).toBe(1);
  });

  it('old strokes (no style or smoothing) look exactly like fountain at smoothing 0', () => {
    const s = stroke('s', 0, 0, 100, 40);
    expect(strokeOutline({ ...s, style: 'fountain', smoothing: 0 })).toEqual(strokeOutline(s));
  });

  it('pen styles: ball barely varies with pressure, brush the most', () => {
    const line = (p: number) => Array.from({ length: 20 }, (_, i) => ({ x: i * 3, y: 0, p, tilt: Math.PI / 2, az: 0, t: i }));
    const height = (style: 'ball' | 'fountain' | 'brush', p: number) => {
      const ys = strokeOutline({ tool: 'pen', width: 4, points: line(p), style, smoothing: 0 }).map((q) => q[1]);
      return Math.max(...ys) - Math.min(...ys);
    };
    const spread = (style: 'ball' | 'fountain' | 'brush') => height(style, 1) - height(style, 0.1);
    expect(spread('ball')).toBeLessThan(spread('fountain'));
    expect(spread('fountain')).toBeLessThan(spread('brush'));
  });

  it('highlighters ignore style and smoothing', () => {
    const hl = { ...stroke('s', 0, 0, 100, 40), tool: 'highlighter' as const, width: 12 };
    expect(strokeOutline({ ...hl, style: 'brush', smoothing: 3 })).toEqual(strokeOutline(hl));
  });

  it('stabilize keeps both ends, drops tiny steps and smooths jitter', () => {
    const jitter = Array.from({ length: 40 }, (_, i) => [i, i % 2 ? 0.4 : -0.4, 0.5]);
    const out = stabilize(jitter, 0, 2);
    expect(out[0]).toEqual(jitter[0]);
    expect(out[out.length - 1]).toEqual(jitter[39]);
    const dense = Array.from({ length: 40 }, (_, i) => [i * 0.1, 0, 0.5]);
    const thin = stabilize(dense, 0.6, 0);
    expect(thin.length).toBeLessThan(dense.length);
    expect(thin[thin.length - 1]).toEqual(dense[39]);
    const inner = out.slice(1, -1).map((q) => Math.abs(q[1]!));
    expect(Math.max(...inner)).toBeLessThan(0.4);
    expect(stabilize(jitter, 0, 0)).toEqual(jitter);
  });

  it('makes a closed SVG path', () => {
    const d = strokeSvgPath(stroke('s', 0, 0, 100, 40));
    expect(d).toMatch(/^M[\d.-]+,[\d.-]+ Q/);
    expect(d.endsWith('Z')).toBe(true);
  });
});

describe('snapShape', () => {
  const kind = (p: InkPoint[], held = 600) => snapShape(p, held)?.kind ?? null;

  it('needs a 350 ms hold', () => {
    expect(snapShape(pts([0, 0], [100, 0]), 349)).toBeNull();
    expect(kind(pts([0, 0], [100, 0]), 350)).toBe('line');
  });

  it('recognises each shape', () => {
    expect(kind(pts([0, 0], [100, 50]))).toBe('line');
    expect(kind(pts([0, 0], [100, 0], [85, -12], [100, 0], [85, 12]))).toBe('arrow');
    expect(kind(pts([0, 0], [120, 0], [120, 80], [0, 80], [0, 1]))).toBe('rect');
    expect(kind(circle(100, 100, 60, 40))).toBe('ellipse');
    expect(kind(pts([0, 100], [50, 0], [100, 100], [1, 100]))).toBe('triangle');
  });

  it('returns null for scribbles and dots', () => {
    expect(kind(pts([0, 0], [40, 60], [60, 0], [100, 60], [130, 10]))).toBeNull();
    expect(kind(pts([0, 0], [2, 2]))).toBeNull();
  });

  it('fits the geometry', () => {
    const r = snapShape(pts([0, 0], [120, 0], [120, 80], [0, 80], [0, 1]), 600)!;
    const want = [[0, 0], [120, 0], [120, 80], [0, 80]];
    r.pts.forEach((p, i) => p.forEach((v, j) => expect(Math.abs(v - want[i]![j]!)).toBeLessThan(2))); // corners sit a resample step inside
    const a = snapShape(pts([0, 0], [100, 0], [85, -12], [100, 0], [85, 12]), 600)!;
    a.pts.flat().forEach((v, i) => expect(v).toBeCloseTo([0, 0, 100, 0][i]!, 6));
  });
});

describe('erase and lasso', () => {
  const items: Item[] = [
    stroke('s1', 0, 0, 100, 0),
    stroke('s2', 0, 50, 100, 50),
    { id: 'sh', type: 'shape', kind: 'rect', pts: [[200, 0], [300, 0], [300, 100], [200, 100]], color: '#000', width: 2 } satisfies ShapeItem,
    { id: 't', type: 'text', x: 0, y: 200, w: 100, text: 'hi', fontSize: 16, color: '#000' },
  ];

  it('erases strokes and shapes the path touches', () => {
    expect(hitTestErase(items, [{ x: 50, y: -20 }, { x: 50, y: 20 }], 2)).toEqual(['s1']); // crosses s1
    expect(hitTestErase(items, [{ x: 50, y: 25 }], 10)).toEqual([]);
    expect(hitTestErase(items, [{ x: 50, y: 42 }], 10)).toEqual(['s2']); // within radius + half width
    expect(hitTestErase(items, [{ x: 250, y: 50 }], 5)).toEqual([]); // inside the rect, away from its edges
    expect(hitTestErase(items, [{ x: 150, y: 10 }, { x: 350, y: 10 }], 1)).toEqual(['sh']);
    expect(hitTestErase(items, [{ x: 50, y: 210 }], 20)).toEqual([]); // text is not ink
  });

  it('selects items mostly inside the lasso', () => {
    const lasso = [{ x: -10, y: -10 }, { x: 110, y: -10 }, { x: 110, y: 260 }, { x: -10, y: 260 }];
    expect(lassoSelect(items, lasso)).toEqual(['s1', 's2', 't']);
    const half = [{ x: -10, y: -10 }, { x: 60, y: -10 }, { x: 60, y: 10 }, { x: -10, y: 10 }];
    expect(lassoSelect(items, half)).toEqual(['s1']);
    const less = [{ x: -10, y: -10 }, { x: 40, y: -10 }, { x: 40, y: 10 }, { x: -10, y: 10 }];
    expect(lassoSelect(items, less)).toEqual([]);
  });
});

describe('paperPattern', () => {
  const size = { w: 595, h: 842 };
  it('uses brand colours', () => {
    expect(paperPattern('blank', 'white', size)).toEqual({ lines: [], dots: [], stroke: '#d9dce3', bg: '#ffffff' });
    expect(paperPattern('blank', 'cream', size).bg).toBe('#fbf7ee');
    expect(paperPattern('blank', 'night', size)).toMatchObject({ stroke: '#34343a', bg: '#1f1f23' });
  });

  it('draws each paper', () => {
    const ruled = paperPattern('ruled', 'white', size);
    expect(ruled.lines[0]).toEqual([0, 72, 595, 72]);
    expect(ruled.lines[1]![1]).toBe(96);
    expect(ruled.lines.every(([, y0, , y1]) => y0 === y1 && y0 <= 842 - 36)).toBe(true);
    expect(paperPattern('dotted', 'white', size).dots.length).toBe(33 * 46);
    const grid = paperPattern('grid', 'white', size);
    expect(grid.lines.length).toBe(33 + 46);
    expect(paperPattern('cornell', 'white', size).lines).toContainEqual([179, 72, 179, 674]);
    expect(paperPattern('weekly', 'white', size).lines).toHaveLength(6);
  });
});
