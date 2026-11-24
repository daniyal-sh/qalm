// Builds the app icons from the brand's graphite tile (assets/brand/mark.mjs) into resources/icons/:
// icon.png (1024), icon.svg, icon.ico (Windows, PNG entries 16–256) and icon.icns (macOS, PNG entries 16–1024).
// The app icon is always the graphite tile (#1c1c1f) with the dark mark (docs/brand.md, "Mark").
// - Windows (.ico, and icon.png for the dev window): full bleed, a rounded tile filling the canvas.
// - macOS (.icns): Apple's grid, an 824/1024 rounded tile with transparent margin.
// Small entries use the brand's heavier weights and a larger mark (weightFor / iconScaleFor), so 16–24 px stay legible.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { initWasm, Resvg } from '@resvg/resvg-wasm';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'resources', 'icons');
const require = createRequire(import.meta.url);
await initWasm(readFileSync(require.resolve('@resvg/resvg-wasm/index_bg.wasm')));

const { iconSvg, iconScaleFor, weightFor } = await import(pathToFileURL(join(here, '..', '..', '..', 'assets', 'brand', 'mark.mjs')).href);

/** Windows: full bleed. `px` is the size it will be shown at, which picks the weight. */
const winSvg = (px = 1024) => iconSvg({ radius: 0.2, weight: weightFor(px), scale: iconScaleFor(px) });
/** macOS: the 824 grid; the tile is 824/1024 of the canvas, so the weight follows the tile's rendered size. */
const macSvg = (px = 1024) => {
  const tilePx = (px * 824) / 1024;
  return iconSvg({ tile: 824, radius: 0.225, weight: weightFor(tilePx), scale: iconScaleFor(tilePx) });
};

const png = (size, src) => Buffer.from(new Resvg(src, { fitTo: { mode: 'width', value: size } }).render().asPng());

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'icon.svg'), winSvg());
writeFileSync(join(out, 'icon.png'), png(1024, winSvg()));
writeFileSync(join(out, 'icon-mac.png'), png(1024, macSvg()));

// ICO: header + directory of PNG-compressed images (Vista+).
{
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const imgs = sizes.map((s) => png(s, winSvg(s)));
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
    const data = png(s, macSvg(s));
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
