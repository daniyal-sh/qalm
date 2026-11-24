// Turns the raw captures (out/raw, DPR 2) into what the README and the site use, in apps/site/public/showcase/:
//   <shot>-<size>-<theme>.png        README: quantised PNG, 1280 px wide (tablet portrait 720)
//   framed/<shot>-<size>-<theme>-<w>.webp|avif   site (960 and 1600 px): on a transparent background: a window (desktop) or a tablet bezel, soft shadow
//   hero-<theme>.png, hero-<theme>-<w>.webp|avif   the desktop window with a portrait tablet in front (PNG on the
//                                    brand canvas, the site's transparent); manifest.json: the site images' sizes
// README and SITE list what is written. node apps/site/showcase/frame.mjs
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OUT } from './core.mjs';

const require = createRequire(import.meta.url);
const sharp = require('sharp');
const RAW = join(OUT, 'raw');
const DEST = fileURLToPath(new URL('../public/showcase/', import.meta.url));

/** [shot, size] for the README: plain screenshots as quantised PNGs (each in light and dark). */
export const README = [
  ['library', 'desktop'],
  ['pdf', 'desktop'],
  ['image', 'tablet'],
  ['markdown', 'tablet'],
  ['planner', 'tablet'],
  ['lasso', 'tablet'],
  ['navigator', 'tablet'],
  ['ai', 'desktop'],
  ['lecture', 'desktop'],
  ['ruler', 'tablet'],
  ['present', 'desktop'],
];
/** [shot, size] for the website: framed, WebP + AVIF. */
export const SITE = [
  ['colours', 'tablet'],
  ['ruler', 'tablet'],
  ['library', 'desktop'],
  ['image', 'tablet'],
  ['lecture', 'desktop'],
  ['present', 'desktop'],
  ['lasso', 'tablet'],
  ['markdown', 'tablet'],
  ['navigator', 'tablet'],
  ['ai', 'desktop'],
];
const BG = { light: '#f3f3f5', dark: '#151517' };

const svgBuf = (s) => Buffer.from(s);
const roundMask = (w, h, r) => svgBuf(`<svg width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${r}" ry="${r}" fill="#fff"/></svg>`);

/** The screenshot with rounded corners inside a frame, on a transparent canvas with a soft shadow. */
async function framed(file, size, theme) {
  const img = sharp(file);
  const { width: W, height: H } = await img.metadata();
  const dark = theme === 'dark';
  if (size === 'desktop') {
    // a plain window: rounded 12 (×2 for DPR), hairline border
    const r = 24, pad = 120;
    const shot = await img.composite([{ input: roundMask(W, H, r), blend: 'dest-in' }]).png().toBuffer();
    const cw = W + pad * 2, ch = H + pad * 2;
    const shadow = svgBuf(`<svg width="${cw}" height="${ch}"><defs><filter id="s" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="40"/></filter></defs>
      <rect x="${pad + 20}" y="${pad + 56}" width="${W - 40}" height="${H - 40}" rx="${r}" fill="#000" opacity="${dark ? 0.55 : 0.2}" filter="url(#s)"/></svg>`);
    const line = svgBuf(`<svg width="${cw}" height="${ch}"><rect x="${pad - 1}" y="${pad - 1}" width="${W + 2}" height="${H + 2}" rx="${r + 1}" fill="none" stroke="${dark ? '#303035' : '#d3d3d9'}" stroke-width="2"/></svg>`);
    return sharp({ create: { width: cw, height: ch, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: shadow }, { input: shot, left: pad, top: pad }, { input: line }])
      .png()
      .toBuffer();
  }
  // a tablet: graphite bezel (the app icon's #1c1c1f), rounded screen
  const bez = 44, rs = 28, rb = rs + bez, pad = 120;
  const shot = await img.composite([{ input: roundMask(W, H, rs), blend: 'dest-in' }]).png().toBuffer();
  const tw = W + bez * 2, th = H + bez * 2;
  const cw = tw + pad * 2, ch = th + pad * 2;
  const body = svgBuf(`<svg width="${cw}" height="${ch}"><defs><filter id="s" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="44"/></filter></defs>
    <rect x="${pad + 24}" y="${pad + 64}" width="${tw - 48}" height="${th - 48}" rx="${rb}" fill="#000" opacity="${dark ? 0.6 : 0.24}" filter="url(#s)"/>
    <rect x="${pad}" y="${pad}" width="${tw}" height="${th}" rx="${rb}" fill="#1c1c1f"/>
    <rect x="${pad + 1.5}" y="${pad + 1.5}" width="${tw - 3}" height="${th - 3}" rx="${rb - 1.5}" fill="none" stroke="#3a3a40" stroke-width="3"/></svg>`);
  return sharp({ create: { width: cw, height: ch, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: body }, { input: shot, left: pad + bez, top: pad + bez }])
    .png()
    .toBuffer();
}

async function writeWeb(buf, base, widths) {
  for (const w of widths) {
    const r = sharp(buf).resize({ width: w, withoutEnlargement: true });
    await r.clone().webp({ quality: 82, effort: 6 }).toFile(`${base}-${w}.webp`);
    await r.clone().avif({ quality: 58, effort: 6 }).toFile(`${base}-${w}.avif`);
  }
}

async function readmePng(buf, out, width) {
  await sharp(buf).resize({ width, withoutEnlargement: true }).png({ palette: true, quality: 88, effort: 10, dither: 0.6, compressionLevel: 9 }).toFile(out);
}

async function hero(theme, transparent = false) {
  const desk = await framed(join(RAW, `pdf-desktop-${theme}.png`), 'desktop', theme);
  const tab = await framed(join(RAW, `image-portrait-${theme}.png`), 'portrait', theme);
  const dm = await sharp(desk).metadata();
  const tabS = await sharp(tab).resize({ height: Math.round(dm.height * 0.86) }).toBuffer();
  const tm = await sharp(tabS).metadata();
  // the tablet in front at the bottom left, over the window's empty margin beside the page
  const W = Math.round(dm.width + tm.width * 0.5), H = dm.height + 40;
  return sharp({ create: { width: W, height: H, channels: 4, background: transparent ? { r: 0, g: 0, b: 0, alpha: 0 } : BG[theme] } })
    .composite([
      { input: desk, left: W - dm.width, top: 0 },
      { input: tabS, left: 0, top: H - tm.height },
    ])
    .png()
    .toBuffer();
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  rmSync(DEST, { recursive: true, force: true });
  mkdirSync(join(DEST, 'framed'), { recursive: true });
  const manifest = {};
  const raw = (name) => {
    const f = join(RAW, `${name}.png`);
    if (!existsSync(f)) throw new Error(`missing capture ${name}`);
    return f;
  };
  for (const [shot, size] of README) {
    for (const theme of ['light', 'dark']) {
      const name = `${shot}-${size}-${theme}`;
      await readmePng(await sharp(raw(name)).toBuffer(), join(DEST, `${name}.png`), size === 'portrait' ? 720 : 1280);
    }
  }
  for (const [shot, size] of SITE) {
    for (const theme of ['light', 'dark']) {
      const f = await framed(raw(`${shot}-${size}-${theme}`), size, theme);
      await writeWeb(f, join(DEST, 'framed', `${shot}-${size}-${theme}`), [960, 1600]);
      const m = await sharp(f).metadata();
      manifest[`${shot}-${size}`] = { path: `framed/${shot}-${size}`, w: 1600, h: Math.round((m.height * 1600) / m.width), widths: [960, 1600] };
    }
  }
  for (const theme of ['light', 'dark']) {
    await readmePng(await hero(theme), join(DEST, `hero-${theme}.png`), 1600);
    const t = await hero(theme, true);
    await writeWeb(t, join(DEST, `hero-${theme}`), [1200, 2400]);
    const m = await sharp(t).metadata();
    manifest.hero = { path: 'hero', w: 2400, h: Math.round((m.height * 2400) / m.width), widths: [1200, 2400] };
  }
  writeFileSync(join(DEST, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const pngs = readdirSync(DEST).filter((f) => f.endsWith('.png')).map((f) => [f, statSync(join(DEST, f)).size]);
  const big = pngs.filter(([, s]) => s > 400_000);
  console.log(`README PNGs: ${pngs.length}, largest ${Math.max(...pngs.map(([, s]) => s)) >> 10} kB${big.length ? `; over 400 kB: ${big.map(([f, s]) => `${f} ${s >> 10} kB`).join(', ')}` : ''}`);
}
