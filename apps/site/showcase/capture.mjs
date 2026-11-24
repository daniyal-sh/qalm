// Captures the showcase: seeds the demo library into a fresh browser profile of the web build (signed in to a local
// server, with a real MCP agent), drives the app into each state, and screenshots it at every size and theme.
//   node apps/site/showcase/capture.mjs [--only=a,b] [--sizes=desktop,tablet,portrait] [--themes=light,dark]
// Needs a web export built against the showcase server: see README.md.
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join } from 'node:path';
import { ROOT, OUT } from './core.mjs';
import { lectureDeck, cellPng } from './assets.mjs';
import { buildLibrary, STUDENT, TUTOR } from './content.mjs';
import { startServer } from './server.mjs';
import { SHOTS } from './shots.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d;
const only = arg('only')?.split(',');
const SIZES = { desktop: [1440, 900], tablet: [1180, 820], portrait: [820, 1180] };
const sizes = arg('sizes', 'desktop,tablet,portrait').split(',');
const themes = arg('themes', 'light,dark').split(',');
export const SERVER_PORT = +(process.env.SHOWCASE_SERVER_PORT ?? 18917);
const RAW = join(OUT, 'raw');
mkdirSync(RAW, { recursive: true });

const dist = join(ROOT, 'apps', 'app', 'dist');
if (!existsSync(join(dist, 'index.html'))) throw new Error(`No web export at ${dist}`);
const webJs = join(dist, '_expo', 'static', 'js', 'web');
const built = readdirSync(webJs).some((f) => f.endsWith('.js') && readFileSync(join(webJs, f), 'utf8').includes(`127.0.0.1:${SERVER_PORT}`));
if (!built) throw new Error(`The web export isn't built for the showcase server: EXPO_PUBLIC_QALM_SERVER_URL=http://127.0.0.1:${SERVER_PORT}`);

// ---- static server for the export (SPA fallback), plus an empty page to seed from before the app boots
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };
const http = createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/__seed') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end('<!doctype html><title>seed</title>');
  }
  let f = join(dist, p);
  if (!existsSync(f) || p.endsWith('/')) f = extname(p) ? f : join(dist, 'index.html');
  if (!existsSync(f)) {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(f)] ?? 'application/octet-stream' });
  res.end(readFileSync(f));
});
await new Promise((r) => http.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${http.address().port}`;

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: [`--remote-debugging-port=${20000 + Math.floor(Math.random() * 30000)}`, '--force-color-profile=srgb', '--hide-scrollbars', '--font-render-hinting=none'],
});
const server = await startServer({ root: ROOT, port: SERVER_PORT, state: join(OUT, 'server-state') });
let agentLoop = null;
try {
  const deckPdf = await lectureDeck(browser, ROOT);
  const lib = await buildLibrary({ deckPdf, cellPng: await cellPng() });
  writeFileSync(join(OUT, 'deck.pdf'), deckPdf);

  const tokens = await server.signIn(STUDENT.email);
  const agentToken = await server.connectAgent(STUDENT.email, TUTOR);
  const { Y } = await import('./core.mjs').then((m) => m.loadCore());
  const b64 = (u8) => Buffer.from(u8).toString('base64');
  const seed = {
    docs: [...lib.docs.map((d) => ({ id: d.docId, u: b64(Y.encodeStateAsUpdate(d.doc)) })), { id: `lib:${tokens.userId}`, u: b64(Y.encodeStateAsUpdate(lib.libDoc)) }],
    assets: lib.assets.map((a) => ({ sha: a.sha, mime: a.mime, b: b64(a.bytes) })),
    local: {
      [`qalm:tokens@127.0.0.1:${SERVER_PORT}`]: { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken },
      'qalm:profile': { email: STUDENT.email, provider: 'email', name: STUDENT.name },
      'qalm:assets:pending': lib.assets.map((a) => ({ sha: a.sha, mime: a.mime })),
      'qalm:tools': { tool: 'pen', penColor: '#1d4ed8', penWidth: 1.2, penStyle: 'fountain' },
    },
  };

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light', reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`${origin}/__seed`);
  await page.evaluate(async ({ docs, assets, local }) => {
    const bin = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    const open = (name, up) =>
      new Promise((res, rej) => {
        const r = indexedDB.open(name, 1);
        r.onupgradeneeded = () => up(r.result);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    const put = (db, store, value, key) =>
      new Promise((res, rej) => {
        const tx = db.transaction(store, 'readwrite');
        if (key === undefined) tx.objectStore(store).add(value);
        else tx.objectStore(store).put(value, key);
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
    for (const d of docs) {
      // y-indexeddb's layout: an autoIncrement `updates` store of Yjs updates, and `custom`
      const db = await open(`qalm:${d.id}`, (db) => {
        db.createObjectStore('updates', { autoIncrement: true });
        db.createObjectStore('custom');
      });
      await put(db, 'updates', bin(d.u));
      db.close();
    }
    const adb = await open('qalm-assets', (db) => db.createObjectStore('blobs'));
    for (const a of assets) await put(adb, 'blobs', new Blob([bin(a.b)], { type: a.mime }), a.sha);
    adb.close();
    for (const [k, v] of Object.entries(local)) localStorage.setItem(k, JSON.stringify(v));
  }, seed);

  const env = {
    page,
    origin,
    lib,
    server,
    agentToken,
    nb: lib.out.notebooks,
    /** Keeps the Tutor agent following (long-polling wait) until stopped. */
    startAgent() {
      if (agentLoop) return;
      const ac = new AbortController();
      let on = true;
      agentLoop = {
        stop: () => {
          on = false;
          ac.abort();
        },
      };
      void (async () => {
        while (on) {
          try {
            const list = await server.mcp(agentToken, 'wait', {}, ac.signal);
            const s = /s=(\S+) "[^"]*" live/.exec(list)?.[1];
            if (s) await server.mcp(agentToken, 'wait', { s }, ac.signal);
            else await new Promise((r) => setTimeout(r, 400));
          } catch {
            await new Promise((r) => setTimeout(r, 400));
          }
        }
      })();
    },
    stopAgent() {
      agentLoop?.stop();
      agentLoop = null;
    },
  };

  for (const shot of SHOTS) {
    if (only && !only.includes(shot.name)) continue;
    for (const size of sizes) {
      if (shot.sizes && !shot.sizes.includes(size)) continue;
      for (const theme of themes) {
        const [w, h] = SIZES[size];
        await page.setViewportSize({ width: w, height: h });
        await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
        const name = `${shot.name}-${size}-${theme}`;
        try {
          await shot.run({ ...env, size, theme, w, h });
          await page.waitForTimeout(shot.settle ?? 700);
          await page.screenshot({ path: join(RAW, `${name}.png`), animations: 'disabled', caret: 'hide' });
          const bad = await page.evaluate(() => (/Untitled|\btest\b|lorem/i.exec(document.body.innerText) ?? [])[0]);
          console.log('shot', name, bad ? `WARNING: "${bad}" on screen` : '');
        } catch (e) {
          console.log('FAILED', name, e.message.split('\n')[0]);
          await page.screenshot({ path: join(RAW, `${name}.FAILED.png`) }).catch(() => {});
        }
        await shot.after?.({ ...env, size, theme }).catch(() => {});
      }
    }
  }
  const uniq = [...new Set(errors)].filter((e) => !/favicon|ResizeObserver/.test(e));
  if (uniq.length) console.log('page errors:\n ', uniq.slice(0, 12).join('\n  '));
} finally {
  agentLoop?.stop();
  await browser.close();
  await server.stop();
  http.close();
}
