#!/usr/bin/env node
/**
 * Editor benchmark: serves a bench web export (EXPO_PUBLIC_QALM_BENCH=1) and drives headless Chrome over CDP.
 *
 *   EXPO_PUBLIC_QALM_BENCH=1 pnpm --filter @qalm/app export:web
 *   node apps/app/scripts/bench/run.mjs --label after [--runs 3] [--profile <dir>] [--dist <web export>] [--chrome <exe>]
 *
 * Seeds (once per profile) a 300-page mixed notebook (blank pages, 300-stroke pages and 3000/5000-stroke pages) and a
 * 300-page PDF import, then measures: open to first page drawn, scroll frame times and long tasks, memory after
 * scrolling through every page (JS heap after GC, docs held, blob bytes alive), and ctrl+wheel zoom (frame times during
 * the gesture, re-layout time after it ends). Prints a table and writes JSON next to the profile.
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? '1' : all[i + 1]]] : acc), []),
);
const dist = path.resolve(args.dist ?? path.resolve(here, '../../dist'));
const label = args.label ?? 'run';
const runs = Number(args.runs ?? 3);
const profile = path.resolve(args.profile ?? path.join(os.tmpdir(), 'qalm-bench-profile'));
const chromeExe =
  args.chrome ??
  ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => fs.existsSync(p));
const PORT = Number(args.port ?? 8765);
const CDP_PORT = Number(args.cdpPort ?? 9333);

if (!fs.existsSync(path.join(dist, 'index.html'))) throw new Error(`no web export at ${dist}; run EXPO_PUBLIC_QALM_BENCH=1 pnpm --filter @qalm/app export:web`);
if (!chromeExe) throw new Error('Chrome not found; pass --chrome');

// ---- static server (SPA fallback) ----
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
  let file = path.join(dist, url);
  if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, 'index.html');
  res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const origin = `http://127.0.0.1:${PORT}`;

// ---- Chrome ----
fs.mkdirSync(profile, { recursive: true });
const chrome = spawn(
  chromeExe,
  [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    '--window-size=1280,900',
    '--enable-precise-memory-info',
    '--js-flags=--expose-gc',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    'about:blank',
  ],
  { stdio: 'ignore' },
);
const stopChrome = () => {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' });
    else chrome.kill('SIGKILL');
  } catch {}
};
process.on('exit', stopChrome);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function targets() {
  for (let i = 0; i < 50; i++) {
    try {
      return await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
    } catch {
      await sleep(200);
    }
  }
  throw new Error('Chrome did not start');
}
const page = (await targets()).find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let nextId = 1;
const pending = new Map();
const listeners = new Set();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(m.error.message)) : resolve(m.result);
  } else if (m.method) for (const l of listeners) l(m);
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
async function evaluate(expr, timeoutMs = 120000) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: timeoutMs });
  if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`);
  return r.result.value;
}
async function waitFor(expr, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await evaluate(expr).catch(() => false)) return true;
    await sleep(50);
  }
  return false;
}

await send('Page.enable');
await send('Runtime.enable');
await send('Performance.enable');
// Instrumentation in every document: long tasks, frame times, blob URLs alive.
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
    window.__lt = [];
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push([e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: true });
    window.__blobs = new Map();
    const c = URL.createObjectURL, r = URL.revokeObjectURL;
    URL.createObjectURL = (b) => { const u = c(b); window.__blobs.set(u, b.size || 0); return u; };
    URL.revokeObjectURL = (u) => { window.__blobs.delete(u); r(u); };
    window.__frames = null;
    window.__startFrames = () => { window.__frames = []; const f = (t) => { if (!window.__frames) return; window.__frames.push(t); requestAnimationFrame(f); }; requestAnimationFrame(f); };
    window.__stopFrames = () => { const f = window.__frames || []; window.__frames = null; return f; };
  `,
});

async function navigate(url) {
  await send('Page.navigate', { url });
  await waitFor('document.readyState === "complete"', 30000);
}

const results = { label, date: new Date().toISOString(), chrome: chromeExe, runs, open: {}, scroll: {}, memory: {}, zoom: {} };

// ---- seed ----
await navigate(`${origin}/`);
if (!(await waitFor('!!window.__qalmBench', 30000))) throw new Error('bench hook missing: build with EXPO_PUBLIC_QALM_BENCH=1');
const seeded = await evaluate('localStorage.getItem("qalm-bench-seeded")');
let ids;
if (!seeded) {
  await sleep(1500); // library doc loads
  console.log('seeding (300-page mixed + 300-page PDF)…');
  ids = await evaluate('window.__qalmBench.seed()', 600000);
  await evaluate(`localStorage.setItem("qalm-bench-seeded", ${JSON.stringify(JSON.stringify(ids))})`);
  console.log(`seeded in ${(ids.ms / 1000).toFixed(1)} s`);
  await sleep(1500);
} else ids = JSON.parse(seeded);

const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
  return { median: q(0.5), p95: q(0.95), max: s[s.length - 1] ?? 0, n: s.length };
};
const round = (o) => JSON.parse(JSON.stringify(o, (_k, v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v)));
const heap = async () => {
  await send('HeapProfiler.collectGarbage');
  await sleep(300);
  await send('HeapProfiler.collectGarbage');
  const m = await send('Performance.getMetrics');
  return (m.metrics.find((x) => x.name === 'JSHeapUsedSize')?.value ?? 0) / 1048576;
};
const scrollerJs = `(() => { let best = null; for (const el of document.querySelectorAll('div')) { const s = getComputedStyle(el); if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 10 && (!best || el.scrollHeight > best.scrollHeight)) best = el; } return best; })()`;

// ---- open ----
async function openOnce(nbId, readyExpr) {
  await navigate(`${origin}/notebook/${nbId}`);
  const ok = await waitFor(readyExpr, 30000);
  await sleep(1500);
  return evaluate(`(() => {
    const m = (n) => performance.getEntriesByName(n);
    const mount = m('qalm:editor-mount')[0]?.startTime ?? null;
    const drawn = m('qalm:page-drawn').find((e) => e.detail && e.detail.index === 0)?.startTime ?? null;
    const partial = m('qalm:page-partial').find((e) => e.detail && e.detail.index === 0)?.startTime ?? null;
    const pdf = m('qalm:pdf-ready').find((e) => e.detail && e.detail.index === 0)?.startTime ?? null;
    const lt = window.__lt.filter(([s]) => s < (drawn ?? pdf ?? 1e9) + 1500);
    return { ok: ${ok}, editorMount: mount, firstInk: partial ?? drawn, firstPageDrawn: drawn, firstPdfReady: pdf, mountToDrawn: drawn && mount ? drawn - mount : null,
      mountToPdf: pdf && mount ? pdf - mount : null, longestTask: Math.max(0, ...lt.map((x) => x[1])), longTaskMs: lt.reduce((a, x) => a + x[1], 0),
      pagesMounted: document.querySelectorAll('canvas').length, domNodes: document.getElementsByTagName('*').length };
  })()`);
}
for (const [key, nbId, ready] of [
  ['mixed', ids.mixed, `performance.getEntriesByName('qalm:page-drawn').some((e) => e.detail && e.detail.index === 0)`],
  ['pdf', ids.pdf, `performance.getEntriesByName('qalm:pdf-ready').some((e) => e.detail && e.detail.index === 0)`],
]) {
  const all = [];
  for (let i = 0; i < runs; i++) all.push(await openOnce(nbId, ready));
  results.open[key] = { runs: all, firstPageDrawn: stats(all.map((r) => r.firstPageDrawn ?? r.firstPdfReady ?? NaN)), firstInk: stats(all.map((r) => r.firstInk ?? NaN)), mountToFirst: stats(all.map((r) => r.mountToDrawn ?? r.mountToPdf ?? NaN)), longestTask: stats(all.map((r) => r.longestTask)), domNodes: all[0].domNodes };
  console.log(key, 'open', JSON.stringify(round(results.open[key].firstPageDrawn)));
}

// ---- scroll: a steady fling, then memory after every page ----
async function scrollRun(key, nbId, ready) {
  await navigate(`${origin}/notebook/${nbId}`);
  await waitFor(ready, 30000);
  await sleep(1500);
  const heap0 = await heap();
  // A 5000 px/s fling for 8 s, scrolled by frame as a finger fling would.
  const fling = await evaluate(`new Promise((resolve) => {
    const el = ${scrollerJs};
    window.__lt.length = 0;
    window.__startFrames();
    const t0 = performance.now(); const y0 = el.scrollTop;
    const step = (t) => {
      const dt = t - t0;
      el.scrollTop = y0 + dt * 5;
      if (dt < 8000) requestAnimationFrame(step);
      else { const f = window.__stopFrames(); const d = f.slice(1).map((x, i) => x - f[i]); resolve({ frames: d, lt: window.__lt.slice(), pages: el.scrollTop }); }
    };
    requestAnimationFrame(step);
  })`, 60000);
  const lt = fling.lt.map((x) => x[1]);
  results.scroll[key] = {
    frameMs: stats(fling.frames),
    droppedFrames: fling.frames.filter((d) => d > 20).length,
    frames: fling.frames.length,
    longTasks: lt.length,
    longestTask: Math.max(0, ...lt),
    over50: lt.filter((d) => d > 50).length,
  };
  console.log(key, 'scroll', JSON.stringify(round(results.scroll[key])));
  // Then through every page, one viewport every 60 ms, and back to the top.
  const through = await evaluate(`new Promise((resolve) => {
    const el = ${scrollerJs};
    let maxCanvas = 0;
    const tick = () => {
      maxCanvas = Math.max(maxCanvas, document.querySelectorAll('canvas').length);
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) return resolve({ maxCanvas, height: el.scrollHeight });
      el.scrollTop += el.clientHeight;
      setTimeout(tick, 60);
    };
    tick();
  })`, 300000);
  await sleep(2500);
  const heapEnd = await heap();
  const docs = await evaluate('window.__qalmBench.stats()');
  const wasmMb = await evaluate('(globalThis.CanvasKit?.HEAPU8?.byteLength ?? 0) / 1048576');
  const blobs = await evaluate('(() => { let n = 0, b = 0; for (const s of window.__blobs.values()) { n++; b += s; } return { n, mb: b / 1048576 }; })()');
  results.memory[key] = { heapStartMb: heap0, heapAfterAllPagesMb: heapEnd, docs, blobsAlive: blobs.n, blobMb: blobs.mb, skiaWasmMb: wasmMb, maxCanvases: through.maxCanvas, contentHeightPx: through.height };
  console.log(key, 'memory', JSON.stringify(round(results.memory[key])));
}
await scrollRun('mixed', ids.mixed, `performance.getEntriesByName('qalm:page-drawn').some((e) => e.detail && e.detail.index === 0)`);
await scrollRun('pdf', ids.pdf, `performance.getEntriesByName('qalm:pdf-ready').some((e) => e.detail && e.detail.index === 0)`);

// ---- zoom: ctrl+wheel 1x -> 2x on the two heaviest pages, then back ----
async function zoomOnce(dir) {
  await evaluate('window.__lt.length = 0; window.__startFrames(); performance.clearMarks("qalm:zoom-commit"); true');
  const t0 = await evaluate('performance.now()');
  for (let i = 0; i < 24; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 640, y: 450, deltaX: 0, deltaY: dir * 2.9, modifiers: 2 });
    await sleep(16);
  }
  const tEnd = await evaluate('performance.now()');
  await sleep(2500);
  return evaluate(`(() => {
    const f = window.__stopFrames();
    const commit = performance.getEntriesByName('qalm:zoom-commit')[0]?.startTime ?? null;
    const during = []; const after = [];
    for (let i = 1; i < f.length; i++) (f[i] < ${tEnd} ? during : after).push([f[i], f[i] - f[i - 1]]);
    const slowAfter = after.filter(([t, d]) => commit && t > commit && d > 34);
    const lastSlow = slowAfter.length ? slowAfter[slowAfter.length - 1][0] : commit;
    const lt = window.__lt.map((x) => x[1]);
    return { gestureFrames: during.filter(([t]) => t > ${t0}).map(([, d]) => d), relayoutMs: commit ? lastSlow - commit : null, longestTask: Math.max(0, ...lt) };
  })()`);
}
{
  await navigate(`${origin}/notebook/${ids.mixed}`);
  await waitFor(`performance.getEntriesByName('qalm:page-drawn').some((e) => e.detail && e.detail.index === 0)`, 30000);
  await sleep(2000);
  const ins = [], outs = [];
  for (let i = 0; i < runs; i++) {
    ins.push(await zoomOnce(-1));
    outs.push(await zoomOnce(1));
  }
  const frames = [...ins, ...outs].flatMap((r) => r.gestureFrames);
  results.zoom = {
    gestureFrameMs: stats(frames),
    gestureFps: frames.length ? 1000 / (frames.reduce((a, b) => a + b, 0) / frames.length) : 0,
    relayoutIn: stats(ins.map((r) => r.relayoutMs ?? NaN)),
    relayoutOut: stats(outs.map((r) => r.relayoutMs ?? NaN)),
    longestTask: Math.max(...ins.map((r) => r.longestTask), ...outs.map((r) => r.longestTask)),
  };
  console.log('zoom', JSON.stringify(round(results.zoom)));
}

const out = path.join(path.dirname(profile), `qalm-bench-${label}.json`);
fs.writeFileSync(out, JSON.stringify(round(results), null, 2));
console.log(`\nwrote ${out}`);
ws.close();
server.close();
stopChrome();
process.exit(0);
