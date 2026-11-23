// Fake handwriting for tests and PR images: each glyph is a few polylines (one stroke each) in a 10-wide box whose
// x-height runs from y 8 to the baseline at y 16. `^` raises the next glyph as a superscript.
import { pointsBBox } from '../src/geometry/bbox';
import type { Page, StrokeItem } from '../src';
import { pts } from './helpers';

type PL = [number, number][];
const G: Record<string, PL[]> = {
  x: [[[0, 8], [8, 16]], [[8, 8], [0, 16]]],
  '2': [[[0, 10], [2, 8], [6, 8], [8, 10], [8, 12], [0, 16], [8, 16]]],
  '3': [[[0, 8], [7, 8], [3, 11], [8, 13], [6, 16], [0, 15]]],
  c: [[[8, 9], [5, 8], [2, 9], [0, 12], [2, 15], [5, 16], [8, 15]]],
  o: [[[4, 8], [7, 9], [8, 12], [7, 15], [4, 16], [1, 15], [0, 12], [1, 9], [4, 8]]],
  s: [[[8, 9], [5, 8], [1, 9], [1, 11], [7, 13], [7, 15], [4, 16], [0, 15]]],
  '(': [[[5, 3], [2, 7], [1, 12], [2, 17], [5, 21]]],
  ')': [[[0, 3], [3, 7], [4, 12], [3, 17], [0, 21]]],
  d: [[[8, 10], [5, 8], [1, 9], [0, 12], [1, 15], [4, 16], [8, 14]], [[8, 2], [8, 16]]],
  u: [[[0, 8], [0, 14], [2, 16], [6, 16], [8, 14]], [[8, 8], [8, 16]]],
  '=': [[[0, 10], [8, 10]], [[0, 13], [8, 13]]],
  y: [[[0, 8], [4, 16]], [[8, 8], [2, 22]]],
  '+': [[[4, 8], [4, 16]], [[0, 12], [8, 12]]],
  '∫': [[[9, -6], [7, -8], [5, -6], [4, 12], [3, 30], [1, 32], [-1, 30]]],
};

/** Writes `text` with its top-left at (x, y); a glyph box is `size` high (x-height ≈ size × 0.4). Returns the strokes. */
export function handwriting(prefix: string, text: string, x: number, y: number, size = 20): StrokeItem[] {
  const k = size / 20;
  const out: StrokeItem[] = [];
  let cx = x;
  let sup = false;
  let n = 0;
  for (const ch of text) {
    if (ch === '^') {
      sup = true;
      continue;
    }
    if (ch === ' ') {
      cx += 8 * k;
      continue;
    }
    const g = G[ch];
    if (!g) throw new Error(`no glyph ${ch}`);
    const s = sup ? 0.55 : 1;
    const dy = sup ? -5 * k : 0;
    for (const pl of g) {
      const points = pts(...pl.map(([gx, gy]) => [cx + gx * k * s, y + dy + gy * k * s] as [number, number]));
      out.push({ id: `${prefix}${n++}`, type: 'stroke', tool: 'pen', color: '#27272a', width: 1.6, points, bbox: pointsBBox(points), createdAt: 0 });
    }
    cx += (ch === '∫' ? 12 : 11) * k * s;
    sup = false;
  }
  return out;
}

export function write(page: Page, prefix: string, text: string, x: number, y: number, size?: number): string[] {
  const s = handwriting(prefix, text, x, y, size);
  page.addItems(s);
  return s.map((i) => i.id);
}

/**
 * The owner's page (A4, ruled): `∫ 2x cos(x²) dx` on the rule at y 96–120, a line above it and a line below.
 * `addSub` then writes `u = x²   du = 2x dx` beside the integral.
 */
export const OWNER = {
  above: (p: Page) => write(p, 'h', 'y = 3x', 60, 50),
  integral: (p: Page) => write(p, 'i', '∫ 2x cos(x^2) dx', 60, 100),
  below: (p: Page) => write(p, 'b', 'y = 2', 60, 150),
  addSub: (p: Page) => write(p, 'n', 'u = x^2   du = 2x dx', 236, 100),
};
