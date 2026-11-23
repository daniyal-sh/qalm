// Pure helpers of the main process: deep links, path resolution, IPC validation.
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const s = require('../dist/shared.js');

test('deep links map to app routes', () => {
  assert.equal(s.deepLinkToPath('qalm://auth/email/verify?token=abc'), '/auth/email/verify?token=abc');
  assert.equal(s.deepLinkToPath('qalm:///auth/email/verify?token=a%2Fb'), '/auth/email/verify?token=a%2Fb');
  assert.equal(s.deepLinkToPath('qalm://notebook/n1'), '/notebook/n1');
  assert.equal(s.deepLinkToPath('https://evil.example/x'), null);
  assert.equal(s.deepLinkToPath('not a url'), null);
  assert.equal(s.deepLinkToPath('qalm:////evil.example/x'), '/evil.example/x');
  assert.equal(s.findDeepLink(['qalm.exe', '--flag', 'qalm://auth/x']), 'qalm://auth/x');
  assert.equal(s.findDeepLink(['qalm.exe']), null);
});

test('web paths stay inside the root, extensionless paths are SPA routes', () => {
  const root = resolve('/srv/web');
  assert.deepEqual(s.resolveWebPath(root, '/'), { file: join(root, 'index.html'), isSpaRoute: false });
  assert.deepEqual(s.resolveWebPath(root, '/notebook/abc'), { file: join(root, 'notebook', 'abc'), isSpaRoute: true });
  assert.equal(s.resolveWebPath(root, '/canvaskit.wasm').isSpaRoute, false);
  assert.equal(s.resolveWebPath(root, '/..%2f..%2fsecret.txt'), null);
  assert.equal(s.resolveWebPath(root, '/%E0%A4%A'), null);
  assert.equal(s.mimeFor('x.wasm'), 'application/wasm');
  assert.match(s.mimeFor('pdf.worker.min.mjs'), /javascript/);
});

test('IPC validation', () => {
  assert.deepEqual(s.filtersFor(['application/pdf']), [{ name: 'PDF', extensions: ['pdf'] }]);
  const f = s.filtersFor(['application/pdf', '.qalm', 'application/octet-stream', 'application/zip']);
  assert.deepEqual(f[0], { name: 'All supported', extensions: ['pdf', 'qalm'] });
  assert.throws(() => s.filtersFor('pdf'));
  assert.throws(() => s.filtersFor([1]));
  assert.deepEqual(s.validateSave('../../a:b.pdf', new Uint8Array([1]), 'application/pdf').name, 'a_b.pdf');
  assert.throws(() => s.validateSave('', new Uint8Array(), 'x'));
  assert.throws(() => s.validateSave('a.pdf', [1, 2], 'x'));
  assert.equal(s.openedMime('Doc.PDF'), 'application/pdf');
  assert.equal(s.openedMime('n.qalm'), 'application/x-qalm');
});
