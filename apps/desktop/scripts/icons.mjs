// Builds the app icons from assets/brand/qalm-mark.svg into resources/icons/:
// icon.png (1024), icon.ico (Windows, PNG entries 16–256) and icon.icns (macOS, PNG entries 16–1024).
// The mark sits on a white rounded tile (brand `surface`, `line` hairline) inside Apple's 824/1024 grid.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { initWasm, Resvg } from '@resvg/resvg-wasm';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'resources', 'icons');
const require = createRequire(import.meta.url);
await initWasm(readFileSync(require.resolve('@resvg/resvg-wasm/index_bg.wasm')));

const mark = readFileSync(join(here, '..', '..', '..', 'assets', 'brand', 'qalm-mark.svg'), 'utf8');
const inner = mark.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');

// 1024 canvas with a tile of side `tile` (macOS: 824, Apple's grid; Windows: nearly full bleed), mark ~73% of the tile.
function iconSvg(tile) {
  const o = (1024 - tile) / 2;
  const W = tile * 0.73;
  const H = (W * 100) / 120;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <rect x="${o}" y="${o}" width="${tile}" height="${tile}" rx="${tile * 0.225}" fill="#ffffff" stroke="#d3d3d9" stroke-width="${tile / 200}"/>
  <svg x="${512 - W / 2}" y="${512 - H / 2 + tile / 80}" width="${W}" height="${H}" viewBox="0 0 120 100" fill="none" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>
</svg>`;
}
const svg = iconSvg(824);
const winSvg = iconSvg(960);

const png = (size, src = svg) => Buffer.from(new Resvg(src, { fitTo: { mode: 'width', value: size } }).render().asPng());

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'icon.svg'), svg);
writeFileSync(join(out, 'icon.png'), png(1024));

// ICO: header + directory of PNG-compressed images (Vista+).
{
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const imgs = sizes.map((s) => png(s, winSvg));
  const head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(sizes.length, 4);
  let offset = head.length;
  sizes.forEach((s, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(s >= 256 ? 0 : s, e);
    head.writeUInt8(s >= 256 ? 0 : s, e + 1);
    head.writeUInt16LE(1, e + 4); // planes
    head.writeUInt16LE(32, e + 6); // bpp
    head.writeUInt32LE(imgs[i].length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += imgs[i].length;
  });
  writeFileSync(join(out, 'icon.ico'), Buffer.concat([head, ...imgs]));
}

// ICNS: 'icns' + length, then (type, length, PNG) chunks.
{
  const types = [['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024], ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512]];
  const chunks = types.map(([t, s]) => {
    const data = png(s);
    const h = Buffer.alloc(8);
    h.write(t, 0, 'ascii');
    h.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([h, data]);
  });
  const body = Buffer.concat(chunks);
  const h = Buffer.alloc(8);
  h.write('icns', 0, 'ascii');
  h.writeUInt32BE(body.length + 8, 4);
  writeFileSync(join(out, 'icon.icns'), Buffer.concat([h, body]));
}

console.log(`icons: ${out}`);
