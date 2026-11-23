// Smoke test of the packaged app (release/win-unpacked, or QALM_EXE): library renders, PDF import through the
// native open dialog (stubbed in main), drawing with the mouse, reload on a deep route (SPA fallback), PDF export
// through the native save dialog (stubbed), a qalm:// link handed to a second instance, and no console errors.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron as electron } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const exe =
  process.env.QALM_EXE ??
  (process.platform === 'win32'
    ? join(here, '..', 'release', 'win-unpacked', 'qalm.exe')
    : join(here, '..', 'release', 'mac-universal', 'qalm.app', 'Contents', 'MacOS', 'qalm'));
if (!existsSync(exe)) throw new Error(`No packaged app at ${exe}: run \`pnpm --filter @qalm/desktop build\``);

const tmp = mkdtempSync(join(tmpdir(), 'qalm-e2e-'));
const userData = join(tmp, 'profile');
const pdfIn = join(tmp, 'Lecture notes.pdf');
const pdfOut = join(tmp, 'export.pdf');

const { PDFDocument, StandardFonts } = require('pdf-lib');
{
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  page.drawText('qalm desktop smoke test', { x: 72, y: 700, size: 24, font: await doc.embedFont(StandardFonts.Helvetica) });
  writeFileSync(pdfIn, await doc.save());
}

const log = (...a) => console.log('•', ...a);
// Hosts that are themselves Electron apps may leak ELECTRON_RUN_AS_NODE, which turns qalm.exe into plain Node.
const env = { ...process.env, QALM_USER_DATA: userData };
delete env.ELECTRON_RUN_AS_NODE;
const errors = [];
const app = await electron.launch({ executablePath: exe, env });
let ok = false;
try {
  const win = await app.firstWindow();
  win.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
  win.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  win.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));

  // 1. Library
  await win.getByText('All notebooks').first().waitFor({ timeout: 60_000 });
  log('library rendered at', win.url());

  // 2. Bridge and isolation
  const bridge = await win.evaluate(() => ({
    keys: Object.keys(window.qalmDesktop ?? {}).sort(),
    platform: window.qalmDesktop?.platform,
    version: window.qalmDesktop?.version,
    node: typeof window.require === 'function' || !!window.process?.versions?.node, // Expo shims a bare `process` object on web
    secure: window.isSecureContext,
  }));
  log('qalmDesktop:', JSON.stringify(bridge));
  if (bridge.node) throw new Error('Node is reachable from the page');
  if (!bridge.keys.includes('openFile') || !bridge.keys.includes('saveFile') || !bridge.keys.includes('onDeepLink')) throw new Error('bridge incomplete');

  // 3. Import a PDF through the native open dialog (stubbed in main).
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] });
  }, pdfIn);
  await win.getByText('Import PDF').first().click();
  await win.waitForFunction(() => location.pathname.startsWith('/notebook/'), null, { timeout: 60_000 });
  const ink = win.locator('canvas[style*="crosshair"]').first();
  await ink.waitFor({ timeout: 60_000 });
  await win.waitForTimeout(2500); // pdf.js render + Skia
  log('notebook opened at', win.url());

  // 4. Draw with the mouse.
  const box = await ink.boundingBox();
  if (!box) throw new Error('no ink canvas');
  const clip = { x: box.x, y: box.y, width: Math.min(box.width, 800), height: Math.min(box.height, 600) };
  const before = await win.screenshot({ clip });
  const x0 = box.x + box.width * 0.3;
  const y0 = box.y + Math.min(box.height, 600) * 0.5;
  await win.mouse.move(x0, y0);
  await win.mouse.down();
  for (let i = 1; i <= 20; i++) await win.mouse.move(x0 + i * 12, y0 + Math.sin(i / 3) * 30);
  await win.mouse.up();
  await win.waitForTimeout(1000);
  const after = await win.screenshot({ clip });
  writeFileSync(join(tmp, 'drawn.png'), after);
  if (before.equals(after)) throw new Error('drawing changed nothing on screen');
  log('drew a stroke with the mouse (screenshot changed):', join(tmp, 'drawn.png'));

  // 5. Reload on the deep route: the app:// protocol serves index.html for /notebook/<id>.
  const nbUrl = win.url();
  await win.reload();
  await win.locator('canvas[style*="crosshair"]').first().waitFor({ timeout: 60_000 });
  log('reloaded', nbUrl);

  // 6. Export through the native save dialog (stubbed in main).
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: p });
  }, pdfOut);
  await win.getByLabel('Back to library').first().click();
  await win.getByLabel(/^More for /).first().click();
  await win.getByText('Export PDF').first().click();
  for (let i = 0; i < 60 && !existsSync(pdfOut); i++) await win.waitForTimeout(500);
  if (!existsSync(pdfOut)) throw new Error('export wrote nothing');
  const head = readFileSync(pdfOut).subarray(0, 5).toString('latin1');
  if (head !== '%PDF-') throw new Error(`export is not a PDF (${head})`);
  log(`exported ${readFileSync(pdfOut).length} bytes of PDF through saveFile`);

  // 7. A qalm:// link opened while running reaches the window (second instance → IPC → router).
  const errCount = errors.length;
  const second = spawn(exe, ['qalm://auth/email/verify?token=e2e-test-token-123456'], {
    env,
    stdio: 'ignore',
  });
  await new Promise((r) => second.on('exit', r));
  await win.waitForFunction(() => location.pathname === '/auth/email/verify' && location.search.includes('e2e-test-token-123456'), null, { timeout: 20_000 });
  log('deep link routed to', new URL(win.url()).pathname);
  // Verifying a fake token fails against the server (or there is none): that is the app working, not an error.
  errors.splice(errCount);

  if (errors.length) throw new Error(`console errors:\n  ${errors.join('\n  ')}`);
  log('no console errors');
  ok = true;
} catch (e) {
  console.error(e);
  console.error(`errors so far:\n  ${errors.join('\n  ')}`);
  try {
    writeFileSync(join(tmp, 'failure.png'), await (await app.firstWindow()).screenshot());
  } catch {}
} finally {
  await app.close();
  if (ok) rmSync(tmp, { recursive: true, force: true });
  else console.log('artifacts kept in', tmp);
}
console.log(ok ? 'E2E PASS' : 'E2E FAIL');
process.exit(ok ? 0 : 1);
