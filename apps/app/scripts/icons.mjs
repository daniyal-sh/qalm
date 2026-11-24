// Builds the app's icons and splash images from the brand mark (assets/brand/mark.mjs) into assets/icons/:
//   pnpm --filter @qalm/app icons
// The app icon is always the graphite tile (#1c1c1f) with the dark mark (docs/brand.md, "Mark").
// - icon.png             1024, square and full bleed (iOS and the Android legacy icon; the OS rounds it)
// - adaptive-icon.png    1024 Android adaptive foreground: the dark mark on transparent, inside the 66/108 safe zone;
//                        app.json gives the graphite background colour
// - monochrome-icon.png  1024 Android 13+ themed icon: the same mark in one colour (the launcher tints it)
// - favicon.png          48, the rounded graphite tile (web)
// - splash.png, splash-dark.png  the mark alone (light / dark), for the light and dark splash screens
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { initWasm, Resvg } from '@resvg/resvg-wasm';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'assets', 'icons');
const require = createRequire(import.meta.url);
await initWasm(readFileSync(require.resolve('@resvg/resvg-wasm/index_bg.wasm')));

const brand = await import(pathToFileURL(join(here, '..', '..', '..', 'assets', 'brand', 'mark.mjs')).href);
const { COLORS, TILE, bounds, iconScaleFor, iconSvg, markInner, weightFor } = brand;

const png = (svg, size) => Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng());

/** The mark alone on a transparent square canvas, its ink box `scale` of the canvas wide, centred. */
function markOnCanvas({ colors, scale, size = 1024 }) {
  const b = bounds();
  const w = size * scale;
  const h = (b.h * w) / b.w;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">` +
    `<svg x="${(size - w) / 2}" y="${(size - h) / 2}" width="${w}" height="${h}" viewBox="${b.x} ${b.y} ${b.w} ${b.h}" fill="none">` +
    markInner({ colors }) + `</svg></svg>`;
}

// Android adaptive icons are 108 dp with a 66 dp safe zone (a centred circle, diameter 61% of the canvas). The mark's
// farthest ink from its centre (the orbit's ends) is ~0.52 of its width, so a mark 56% of the canvas wide stays inside
// a 0.305 radius with a little room: launchers that mask to a circle never clip the orbit.
const ADAPTIVE_SCALE = 0.56;
const mono = { ink: '#ffffff', orbit: '#ffffff', planet: '#ffffff' };

const files = {
  'icon.png': png(iconSvg(), 1024),
  'adaptive-icon.png': png(markOnCanvas({ colors: COLORS.dark, scale: ADAPTIVE_SCALE }), 1024),
  'monochrome-icon.png': png(markOnCanvas({ colors: mono, scale: ADAPTIVE_SCALE }), 1024),
  'favicon.png': png(iconSvg({ size: 48, radius: 0.22, weight: weightFor(48), scale: iconScaleFor(48) }), 48),
  'splash.png': png(markOnCanvas({ colors: COLORS.light, scale: 0.9 }), 1024),
  'splash-dark.png': png(markOnCanvas({ colors: COLORS.dark, scale: 0.9 }), 1024),
};
mkdirSync(out, { recursive: true });
for (const [name, data] of Object.entries(files)) {
  writeFileSync(join(out, name), data);
  console.log(`icons: assets/icons/${name}`);
}
const app = JSON.parse(readFileSync(join(here, '..', 'app.json'), 'utf8')).expo;
if (app.android.adaptiveIcon.backgroundColor.toLowerCase() !== TILE) {
  throw new Error(`app.json android.adaptiveIcon.backgroundColor must be the graphite tile, ${TILE}`);
}
