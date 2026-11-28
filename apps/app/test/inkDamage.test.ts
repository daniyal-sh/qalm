import { strokeOutline, type InkPoint, type PenStyle, type Smoothing } from '@qalm/core';
import { describe, expect, it } from 'vitest';

import { changedBounds } from '../../../modules/qalm-ink/src/inkDamage';
import { traceOutline } from '../../../modules/qalm-ink/src/outlinePath';

/** The traced path (quads flattened), as polygons in page units. */
function flatten(outline: number[][]): [number, number][][] {
  const polys: [number, number][][] = [];
  let cur: [number, number][] = [];
  let at: [number, number] = [0, 0];
  traceOutline(outline, {
    moveTo: (x, y) => { cur = [[x, y]]; at = [x, y]; },
    lineTo: (x, y) => { cur.push([x, y]); at = [x, y]; },
    quadTo: (cx, cy, x, y) => {
      for (let k = 1; k <= 8; k++) {
        const t = k / 8;
        const u = 1 - t;
        cur.push([u * u * at[0] + 2 * u * t * cx + t * t * x, u * u * at[1] + 2 * u * t * cy + t * t * y]);
      }
      at = [x, y];
    },
    close: () => { polys.push(cur); },
  });
  return polys;
}

const PX = 4; // raster px per page unit
const GRID = { x0: -10, y0: -20, w: 90 * PX, h: 40 * PX };

/** Non-zero fill of the outline, sampled at pixel centres. */
function raster(outline: number[][]): Uint8Array {
  const g = new Uint8Array(GRID.w * GRID.h);
  const edges = flatten(outline).flatMap((poly) => poly.map((p, i) => [p, poly[(i + 1) % poly.length]!] as const));
  for (let r = 0; r < GRID.h; r++) {
    const y = GRID.y0 + (r + 0.5) / PX;
    const xs: [number, number][] = [];
    for (const [a, b] of edges) {
      if (a[1] <= y !== b[1] <= y) xs.push([a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]), b[1] > a[1] ? 1 : -1]);
    }
    xs.sort((p, q) => p[0] - q[0]);
    let w = 0;
    for (let k = 0; k < xs.length - 1; k++) {
      w += xs[k]![1];
      if (w === 0) continue;
      const c0 = Math.max(0, Math.ceil((xs[k]![0] - GRID.x0) * PX - 0.5));
      const c1 = Math.min(GRID.w - 1, Math.floor((xs[k + 1]![0] - GRID.x0) * PX - 0.5));
      for (let c = c0; c <= c1; c++) g[r * GRID.w + c] = 1;
    }
  }
  return g;
}

function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/** Loopy handwriting at 240 Hz with digitiser jitter and changing pressure, in page units. */
function handwriting(seed: number, n = 160): InkPoint[] {
  const r = rng(seed);
  const pts: InkPoint[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / 240;
    const w = 2 * Math.PI * (1.8 + seed * 0.3);
    pts.push({
      x: t * 55 + 3.5 * Math.cos(w * t + Math.PI) + 3.5 + (r() - 0.5) * 0.25,
      y: -6 * Math.sin(w * t) + (r() - 0.5) * 0.25,
      p: 0.45 + 0.25 * Math.sin(5 * t + seed) + (r() - 0.5) * 0.05,
      tilt: Math.PI / 2 - 0.3 * r(),
      az: 0,
      t: t * 1000,
    });
  }
  return pts;
}

/** A guessed continuation, as the overlays draw it: straight on, at the last real pressure. */
function predicted(pts: InkPoint[], k: number): InkPoint[] {
  const a = pts[pts.length - 3];
  const b = pts[pts.length - 1]!;
  if (!a || k === 0) return [];
  return Array.from({ length: k }, (_, i) => ({ ...b, x: b.x + ((b.x - a.x) * (i + 1)) / 2, y: b.y + ((b.y - a.y) * (i + 1)) / 2 }));
}

describe('live ink damage (changedBounds)', () => {
  it('is null for the same outline', () => {
    const o = strokeOutline({ tool: 'pen', width: 1.8, points: handwriting(1) });
    expect(changedBounds(o, o.map((p) => [...p]))).toBeNull();
    expect(changedBounds([], [])).toBeNull();
  });

  const cases: { tool: 'pen' | 'highlighter'; width: number; style?: PenStyle; smoothing?: Smoothing; predict: number }[] = [
    { tool: 'pen', width: 1.8, style: 'fountain', smoothing: 0, predict: 0 },
    { tool: 'pen', width: 1.8, style: 'fountain', smoothing: 2, predict: 3 },
    { tool: 'pen', width: 2.8, style: 'brush', smoothing: 3, predict: 3 },
    { tool: 'pen', width: 1.2, style: 'ball', smoothing: 1, predict: 1 },
    { tool: 'highlighter', width: 12, predict: 2 },
  ];
  for (const c of cases) {
    it(`holds every changed pixel, frame to frame: ${c.tool} ${c.style ?? ''} smoothing ${c.smoothing ?? '-'} predict ${c.predict}`, () => {
      let ratio = 0;
      let frames = 0;
      for (const seed of [1, 2]) {
        const all = handwriting(seed);
        let prev: number[][] | null = null;
        let prevRaster: Uint8Array | null = null;
        // Every 1..4 samples, as input arrives between frames.
        for (let n = 1, step = 1; n <= all.length; n += step, step = (step % 4) + 1) {
          const real = all.slice(0, n);
          const out = strokeOutline({ ...c, points: real.concat(predicted(real, c.predict)) });
          const g = raster(out);
          if (prev && prevRaster) {
            const box = changedBounds(prev, out);
            const fullBox = [prev, out].flat().reduce((m, p) => [Math.min(m[0]!, p[0]!), Math.min(m[1]!, p[1]!), Math.max(m[2]!, p[0]!), Math.max(m[3]!, p[1]!)], [Infinity, Infinity, -Infinity, -Infinity]);
            if (n > 40) {
              ratio += box ? ((box[2] - box[0]) * (box[3] - box[1])) / ((fullBox[2]! - fullBox[0]!) * (fullBox[3]! - fullBox[1]!)) : 0;
              frames++;
            }
            const slack = 1 / PX;
            for (let i = 0; i < g.length; i++) {
              if (g[i] === prevRaster[i]) continue;
              const x = GRID.x0 + ((i % GRID.w) + 0.5) / PX;
              const y = GRID.y0 + (Math.floor(i / GRID.w) + 0.5) / PX;
              expect(box, `frame ${n}: a pixel changed but the outlines compare equal`).not.toBeNull();
              const inside = x >= box![0] - slack && x <= box![2] + slack && y >= box![1] - slack && y <= box![3] + slack;
              expect(inside, `frame ${n}: changed pixel (${x}, ${y}) outside [${box!.map((v) => v.toFixed(2))}]`).toBe(true);
            }
          }
          prev = out;
          prevRaster = g;
        }
      }
      // And it is worth it: once the stroke is a few letters long, a frame redraws a small part of its box (pens ~0.1-0.3, the wide highlighter ~0.4 on these short strokes).
      expect(ratio / frames).toBeLessThan(0.5);
    });
  }
});
