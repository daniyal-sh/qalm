// One browser, several shots, then close. Usage: node shot.mjs <file.html or http://…> <outdir> <spec...>
// spec = name:width:height:scheme[:full][:motion=reduce][:wait=ms][:scroll=selector]
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url); // playwright-core from the repo's node_modules
const { chromium } = require('playwright-core');

const [file, outdir, ...specs] = process.argv.slice(2);
const port = 20000 + Math.floor(Math.random() * 30000);
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: [`--remote-debugging-port=${port}`, '--disable-gpu-sandbox', '--force-color-profile=srgb'],
});
try {
  for (const spec of specs) {
    const [name, w, h, scheme, ...rest] = spec.split(':');
    const opts = Object.fromEntries(rest.map((r) => (r.includes('=') ? r.split('=') : [r, true])));
    const ctx = await browser.newContext({ viewport: { width: +w, height: +h }, colorScheme: scheme, reducedMotion: opts.motion === 'reduce' ? 'reduce' : 'no-preference', deviceScaleFactor: opts.dpr ? +opts.dpr : 1 });
    const page = await ctx.newPage();
    const errs = [];
    page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
    page.on('pageerror', (e) => errs.push(String(e)));
    await page.goto(/^https?:/.test(file) ? file : pathToFileURL(file).href, { waitUntil: 'networkidle' });
    if (opts.scroll) await page.locator(opts.scroll).first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(+(opts.wait ?? 400));
    const sw = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth, document.documentElement.scrollHeight]);
    await page.screenshot({ path: `${outdir}/${name}.png`, fullPage: !!opts.full });
    console.log(name, 'scrollW/clientW/H', sw.join('/'), errs.length ? 'ERRORS ' + errs.join(' | ') : '');
    await ctx.close();
  }
} finally {
  await browser.close();
}
