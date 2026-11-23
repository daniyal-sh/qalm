// Writes android/src/test/resources/freehand-fixture.txt: stroke outlines computed by @qalm/core `strokeOutline`,
// which QalmFreehandTest.kt compares against the Kotlin port. Run: pnpm --filter qalm-ink gen:fixture
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { strokeOutline } from '../../../packages/core/src/geometry/stroke';
import type { InkPoint } from '../../../packages/core/src/types';

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

const cases: [string, 'pen' | 'highlighter', number, InkPoint[]][] = [
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

let s = '';
for (const [name, tool, width, pts] of cases) {
  const out = strokeOutline({ tool, width, points: pts });
  s += `case ${name} ${tool} ${width}\npts ${pts.length}\n`;
  for (const q of pts) s += `${q.x} ${q.y} ${q.p} ${q.tilt}\n`;
  s += `out ${out.length}\n`;
  for (const [x, y] of out) s += `${x} ${y}\n`;
}
const file = join(process.cwd(), 'android/src/test/resources/freehand-fixture.txt'); // run from the module root
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, s);
console.log(`wrote ${cases.length} cases to ${file}`);
