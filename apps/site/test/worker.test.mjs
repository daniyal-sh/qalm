import assert from 'node:assert/strict';
import { test } from 'node:test';

import { byteRange, downloadFor, isAppRoute } from '../src/routes.js';
import worker from '../src/worker.js';

test('app routes fall back; files and other paths do not', () => {
  for (const p of ['/app', '/app/', '/app/notebook/3f2a-11', '/app/auth/email/verify', '/app/settings']) assert.equal(isAppRoute(p), true, p);
  for (const p of ['/', '/about', '/apple', '/application/x', '/app/_expo/static/js/web/entry-abc.js', '/app/canvaskit.wasm', '/app/x.png']) assert.equal(isAppRoute(p), false, p);
});

function assets(files) {
  return {
    async fetch(req) {
      const path = new URL(req.url).pathname;
      return files[path] ? new Response(files[path], { status: 200 }) : new Response('not found', { status: 404 });
    },
  };
}

test('a deep link with a query gets the app shell', async () => {
  const env = { ASSETS: assets({ '/app/': 'shell' }) };
  const res = await worker.fetch(new Request('https://qalm.apollolearn.app/app/auth/email/verify?token=t'), env);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'shell');
});

test('existing files pass through; missing app files, POSTs and landing paths stay 404', async () => {
  const env = { ASSETS: assets({ '/app/': 'shell', '/app/manifest.json': '{}' }) };
  assert.equal(await (await worker.fetch(new Request('https://x/app/manifest.json'), env)).text(), '{}');
  assert.equal((await worker.fetch(new Request('https://x/app/_expo/static/js/old.js'), env)).status, 404);
  assert.equal((await worker.fetch(new Request('https://x/app/notebook/1', { method: 'POST' }), env)).status, 404);
  assert.equal((await worker.fetch(new Request('https://x/nope'), env)).status, 404);
});

// ---- downloads (R2) ----

const UNAVAILABLE = '<h1><span data-platform>This download</span> isn’t available yet.</h1>';

/** A stand-in for an R2 bucket: head/get with R2's range parsing (bytes=a-b, a-, -n) and If-None-Match. */
function bucket(objects) {
  const meta = (key) => {
    const data = objects[key];
    return data === undefined ? null : { key, size: data.length, httpEtag: `"etag-${key}"`, uploaded: new Date('2026-11-20T10:00:00Z') };
  };
  return {
    async head(key) {
      return meta(key);
    },
    async get(key, opts = {}) {
      const m = meta(key);
      if (!m) return null;
      const h = opts.onlyIf;
      if (h?.get?.('If-None-Match') === m.httpEtag) return m; // no body: the condition failed
      let range;
      const r = opts.range?.get?.('Range');
      if (r) {
        const [, a, b] = /^bytes=(\d*)-(\d*)$/.exec(r) ?? [];
        if (a === '' && b !== '') range = { suffix: Number(b) };
        else if (b === '') range = { offset: Number(a) };
        else range = { offset: Number(a), length: Number(b) - Number(a) + 1 };
        if ((range.offset ?? 0) >= m.size) throw new RangeError('InvalidRange');
      }
      const data = objects[key];
      const pos = range ? byteRange(range, m.size) : { start: 0, end: m.size - 1 };
      return { ...m, range, body: new Response(data.slice(pos.start, pos.end + 1)).body };
    },
  };
}

const site = (objects) => ({ ASSETS: assets({ '/download/unavailable': UNAVAILABLE, '/app/': 'shell' }), DOWNLOADS: bucket(objects) });

test('download paths', () => {
  assert.equal(downloadFor('/download/windows').filename, 'qalm-setup.exe');
  assert.equal(downloadFor('/download/android/').filename, 'qalm.apk');
  for (const p of ['/download', '/download/', '/download/linux', '/download/windows/x', '/download/toString', '/download/unavailable']) assert.equal(downloadFor(p), null, p);
});

test('the Windows installer streams from R2 as an attachment', async () => {
  const res = await worker.fetch(new Request('https://qalm.apollolearn.app/download/windows'), site({ 'windows/qalm-setup.exe': 'MZ-installer' }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'application/vnd.microsoft.portable-executable');
  assert.equal(res.headers.get('Content-Disposition'), 'attachment; filename="qalm-setup.exe"');
  assert.equal(res.headers.get('Content-Length'), '12');
  assert.equal(res.headers.get('ETag'), '"etag-windows/qalm-setup.exe"');
  assert.equal(res.headers.get('Accept-Ranges'), 'bytes');
  assert.equal(await res.text(), 'MZ-installer');
});

test('the Android APK has its own type and filename; HEAD has no body', async () => {
  const env = site({ 'android/qalm.apk': 'PK-apk-bytes' });
  const res = await worker.fetch(new Request('https://x/download/android'), env);
  assert.equal(res.headers.get('Content-Type'), 'application/vnd.android.package-archive');
  assert.equal(res.headers.get('Content-Disposition'), 'attachment; filename="qalm.apk"');
  assert.equal(await res.text(), 'PK-apk-bytes');
  const head = await worker.fetch(new Request('https://x/download/android', { method: 'HEAD' }), env);
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('Content-Length'), '12');
  assert.equal(await head.text(), '');
});

test('ranges resume a download', async () => {
  const env = site({ 'windows/qalm-setup.exe': '0123456789' });
  const get = (range) => worker.fetch(new Request('https://x/download/windows', { headers: { Range: range } }), env);
  let res = await get('bytes=2-5');
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('Content-Range'), 'bytes 2-5/10');
  assert.equal(res.headers.get('Content-Length'), '4');
  assert.equal(await res.text(), '2345');
  res = await get('bytes=7-');
  assert.equal(res.headers.get('Content-Range'), 'bytes 7-9/10');
  assert.equal(await res.text(), '789');
  res = await get('bytes=-3');
  assert.equal(res.headers.get('Content-Range'), 'bytes 7-9/10');
  res = await get('bytes=50-');
  assert.equal(res.status, 416);
  assert.equal(res.headers.get('Content-Range'), 'bytes */10');
});

test('a matching If-None-Match gets 304', async () => {
  const res = await worker.fetch(new Request('https://x/download/windows', { headers: { 'If-None-Match': '"etag-windows/qalm-setup.exe"' } }), site({ 'windows/qalm-setup.exe': 'x' }));
  assert.equal(res.status, 304);
});

test('a missing installer gets the friendly page, naming the platform', async () => {
  for (const [path, label] of [['/download/windows', 'Windows'], ['/download/android', 'Android']]) {
    const res = await worker.fetch(new Request(`https://x${path}`), site({}));
    assert.equal(res.status, 404);
    assert.match(res.headers.get('Content-Type'), /^text\/html/);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    assert.equal(await res.text(), `<h1><span data-platform>The ${label} download</span> isn’t available yet.</h1>`);
  }
  // No bucket bound at all (e.g. a misconfigured env) is the same.
  const res = await worker.fetch(new Request('https://x/download/android'), { ASSETS: assets({ '/download/unavailable': UNAVAILABLE }) });
  assert.equal(res.status, 404);
  assert.match(await res.text(), /The Android download/);
});

test('downloads are GET/HEAD only; other /download paths are plain assets', async () => {
  const env = site({ 'windows/qalm-setup.exe': 'x' });
  const post = await worker.fetch(new Request('https://x/download/windows', { method: 'POST' }), env);
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('Allow'), 'GET, HEAD');
  assert.equal((await worker.fetch(new Request('https://x/download/linux'), env)).status, 404);
  assert.equal(await (await worker.fetch(new Request('https://x/download/unavailable'), env)).text(), UNAVAILABLE);
});
