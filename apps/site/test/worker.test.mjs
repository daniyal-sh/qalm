import assert from 'node:assert/strict';
import { test } from 'node:test';

import worker, { isAppRoute } from '../src/worker.js';

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
