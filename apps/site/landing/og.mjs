// Renders, with headless Chrome, the social preview (public/og.png, 1200×630) from the hero, and the app icon's PNGs
// (the graphite tile, assets/brand/mark.mjs): apple-touch-icon.png (180, square: iOS rounds it), favicon-32.png and
// favicon-16.png (rounded, for browsers without SVG favicons) and brand/qalm-icon-96.png (rounded, the mark in qalm's
// emails, shown at 48 px). Run after changing the hero or the mark:  pnpm --filter @qalm/site build:og
// One browser, on a random free debugging port, closed at the end. Chrome: CHROME_PATH or the default Windows install.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hero, staticSvgInner } from './pieces.mjs';
import { underline } from './landing.mjs';
import { SHARED_CSS, iconForPng, mark } from './site.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const pub = new URL('../public/', import.meta.url);

const ink = staticSvgInner(hero()).replace('<g class="hl">', '<g class="hl-ink">').replace('<g class="pen">', '<g class="pen-ink">');

const og = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700&display=swap">
<style>${SHARED_CSS}
:root{color-scheme:light}
html,body{margin:0;width:1200px;height:630px;overflow:hidden;background:#f6f6f8}
.og{display:grid;grid-template-columns:520px 1fr;gap:40px;align-items:center;height:630px;padding:0 0 0 72px;box-sizing:border-box}
.lockup svg{width:55px;height:50px}
.lockup b{font-size:26px}
.lockup small{font-size:15px}
h1{font-size:68px;line-height:1;letter-spacing:-.045em;font-weight:600;margin:40px 0 0;color:#27272a}
.url{margin-top:34px;font-size:20px;color:#5c5c65;font-weight:500}
.paper{background:#fff;border-radius:8px;box-shadow:0 1px 2px rgba(0,0,0,.05),0 30px 60px -30px rgba(24,24,40,.35),0 0 0 1px rgba(0,0,0,.06);width:660px;transform:rotate(-2deg);margin-top:30px}
.paper svg{display:block;width:100%;height:auto}
.pen-ink{fill:#27272a}
.hl-ink path{fill:#fde68a;opacity:.85;mix-blend-mode:multiply}
</style></head><body>
<svg width="0" height="0" style="position:absolute"><defs><pattern id="dots" width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="10" cy="10" r="1.1" fill="#d9dce3"/></pattern></defs></svg>
<div class="og">
  <div>
    <span class="lockup">${mark('og')}<span class="name"><b>qalm</b><small>by Apollo</small></span></span>
    <h1>Finally, a handwriting app that <span class="underline">doesn't suck.${underline()}</span></h1>
    <p class="url">qalm.apollolearn.app</p>
  </div>
  <div class="paper"><svg viewBox="0 0 600 440"><rect width="600" height="440" fill="url(#dots)"/>${ink}</svg></div>
</div></body></html>`;

/** A page that is just the icon at `px`, edge to edge. */
const iconPage = (svg) => `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:transparent}svg{display:block}</style></head><body>${svg}</body></html>`;
const icons = [
  ['apple-touch-icon.png', 180, { square: true }],
  ['favicon-32.png', 32, {}],
  ['favicon-16.png', 16, {}],
  ['brand/qalm-icon-96.png', 96, {}],
].map(([name, px, o]) => [name, iconPage(iconForPng(px, o)), px, px, true]);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qalm-og-'));
const port = 20000 + Math.floor(Math.random() * 30000);
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: [`--remote-debugging-port=${port}`, '--force-color-profile=srgb'],
});
try {
  for (const [name, html, w, h, transparent] of [['og.png', og, 1200, 630], ...icons]) {
    const file = path.join(dir, name.replace(/\//g, '-').replace('.png', '.html'));
    fs.writeFileSync(file, html);
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: 'light', deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.goto(pathToFileURL(file).href, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    const target = fileURLToPath(new URL(name, pub));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    await page.screenshot({ path: target, type: 'png', omitBackground: Boolean(transparent) });
    await ctx.close();
    console.log(`og: public/${name} (${w}×${h})`);
  }
} finally {
  await browser.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
