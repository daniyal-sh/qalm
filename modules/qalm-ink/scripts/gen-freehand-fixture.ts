// Writes android/src/test/resources/freehand-fixture.txt: stroke outlines computed by @qalm/core `strokeOutline`,
// which QalmFreehandTest.kt compares against the Kotlin port. Run: pnpm --filter qalm-ink gen:fixture
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { strokeOutline } from '../../../packages/core/src/geometry/stroke';
import type { InkPoint, PenStyle, Smoothing } from '../../../packages/core/src/types';

let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

const pt = (x: number, y: number, p = 0.5, tilt = Math.PI / 2, t = 0): InkPoint => ({ x, y, p, tilt, az: 0, t });

function walk(n: number): InkPoint[] {
  const out: InkPoint[] = [];
  let x = 100, y = 100, a = 0;
  for (let i = 0; i < n; i++) {
    a += (rnd() - 0.5) * 0.8;
    const step = 0.3 + rnd() * 3;
    x += Math.cos(a) * step;
    y += Math.sin(a) * step;
    out.push(pt(x, y, 0.1 + rnd() * 0.9, 0.3 + rnd() * 1.2, i * 4));
  }
  return out;
}

const zigzag: InkPoint[] = [];
for (let i = 0; i < 40; i++) zigzag.push(pt(50 + (i % 10) * 4, 50 + Math.floor(i / 10) * (i % 2 ? 6 : -6) + i, 0.6, 1.0, i * 8));

// [name, tool, width, points, style, smoothing]: no style/smoothing = a stroke from before they existed.
type Case = [string, 'pen' | 'highlighter', number, InkPoint[], PenStyle?, Smoothing?];
const cases: Case[] = [
  ['dot', 'pen', 1.8, [pt(10, 10, 0.7, 1.2)]],
  ['two', 'pen', 1.8, [pt(10, 10, 0.7, 1.2), pt(20, 14, 0.4, 1.0)]],
  ['three', 'pen', 2.8, [pt(10, 10), pt(12, 11), pt(30, 30)]],
  ['tap-same', 'pen', 1.2, [pt(5, 5), pt(5, 5), pt(5, 5)]],
  ['walk-pen', 'pen', 1.8, walk(200)],
  ['walk-thin', 'pen', 1.2, walk(60)],
  ['walk-hl', 'highlighter', 12, walk(150)],
  ['zigzag', 'pen', 2.8, zigzag],
  ['back', 'pen', 1.8, [pt(0, 0), pt(10, 0), pt(20, 0), pt(30, 0), pt(20, 0.5), pt(10, 1), pt(0, 1)]],
];
// Every style at every smoothing level, on a noisy walk, plus the short and dense edge cases.
const noisy = walk(180);
for (const style of ['fountain', 'ball', 'brush'] as const) {
  for (const sm of [0, 1, 2, 3] as const) cases.push([`${style}-s${sm}`, 'pen', 2.8, noisy, style, sm]);
  cases.push([`${style}-zigzag`, 'pen', 1.8, zigzag, style, 3]);
  cases.push([`${style}-two`, 'pen', 1.8, [pt(10, 10, 0.7, 1.2), pt(20, 14, 0.4, 1.0)], style, 2]);
  cases.push([`${style}-dense`, 'pen', 1.8, Array.from({ length: 30 }, (_, i) => pt(10 + i * 0.1, 10 + (i % 3) * 0.05, 0.2 + (i % 5) * 0.15, 1.1)), style, 3]);
}
cases.push(['hl-smoothed', 'highlighter', 12, walk(40), 'brush', 3]); // highlighters ignore style and smoothing

let s = '';
for (const [name, tool, width, pts, style, smoothing] of cases) {
  const out = strokeOutline({ tool, width, points: pts, style, smoothing });
  s += `case ${name} ${tool} ${width} ${style ?? '-'} ${smoothing ?? '-'}\npts ${pts.length}\n`;
  for (const q of pts) s += `${q.x} ${q.y} ${q.p} ${q.tilt}\n`;
  s += `out ${out.length}\n`;
  for (const [x, y] of out) s += `${x} ${y}\n`;
}
const file = join(process.cwd(), 'android/src/test/resources/freehand-fixture.txt'); // run from the module root
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, s);
console.log(`wrote ${cases.length} cases to ${file}`);
