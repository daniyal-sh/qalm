// Quick look at generated ink without the app: renders pages with @qalm/core's renderPageSvg to PNG.
// node apps/site/showcase/preview.mjs  -> out/preview-*.png
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import * as Y from 'yjs';
import { loadCore, OUT } from './core.mjs';
import { Hand, highlight } from './hand.mjs';

const require = createRequire(import.meta.url);
const sharp = require('sharp');
const { Page, renderPageSvg } = await loadCore();

export async function previewPage(name, info, page, scale = 2) {
  const svg = renderPageSvg(info, page);
  await sharp(Buffer.from(svg), { density: 72 * scale }).png().toFile(`${OUT}preview-${name}.png`);
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  const doc = new Y.Doc();
  const page = new Page(doc);
  const info = { id: 'p', size: { w: 595, h: 842 }, paper: 'ruled', paperColor: 'white', background: { kind: 'paper' } };
  const clock = { t: Date.UTC(2026, 10, 20, 9) };
  const h = new Hand({ seed: 3, clock });
  const items = [];
  const title = h.write('Derivatives', 40, 62, { size: 2.2, color: '#4338ca' });
  items.push(...title.items, h.underline(title.bbox, { color: '#4338ca' }));
  const lines = [
    'The derivative of f at x is the slope of the tangent:',
    "f'(x) = lim (f(x+h) - f(x)) / h   as h → 0",
    'Power rule: d/dx x^{2} = 2x,  d/dx x^{n} = n·x^{n-1}',
    'Kinematics: velocity is the derivative of position.',
    'Mitochondria! Fonctions dérivées, coeur, Grüße.',
  ];
  lines.forEach((l, i) => items.push(...h.write(l, 40, 72 + 24 * (i + 1)).items));
  const hl = h.write('Chain rule: (f·g)\' = f\'(g)·g\'', 40, 72 + 24 * 7);
  items.unshift(highlight(hl.bbox, '#fde68a', clock, 4));
  items.push(...hl.items, h.loop(hl.bbox, { color: '#b91c1c' }));
  items.push(...h.arrow([300, 300], [380, 250], { color: '#0f766e' }));
  const cur = new Hand({ font: 'EMSAllure', seed: 9, clock, xh: 8 });
  items.push(...cur.write('La Révolution française, 1789', 40, 72 + 24 * 10, { size: 1.3 }).items);
  page.addItems(items);
  await previewPage('hand', info, page, 3);
  writeFileSync(`${OUT}preview-hand.txt`, `${items.length} items\n`);
  console.log('ok', items.length);
}
