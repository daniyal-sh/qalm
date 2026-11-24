// Smoke test of the packaged app (release/win-unpacked, or QALM_EXE): library renders, PDF import through the
// native open dialog (stubbed in main), drawing with the mouse, reload on a deep route (SPA fallback), PDF export
// through the native save dialog (stubbed), a qalm:// link handed to a second instance, and no console errors.
//
// A build with a server URL (EXPO_PUBLIC_QALM_SERVER_URL) opens on the sign-in screen with a fresh profile:
//   QALM_E2E_SIGNIN=skip  (default) "Continue without an account"
//   QALM_E2E_SIGNIN=code  sign in with the 6-digit code from the email
//   QALM_E2E_SIGNIN=link  sign in by opening the email's qalm:// link (a second instance hands it over)
// code and link read the email from the server's console: QALM_E2E_SERVER_LOG=<file with `wrangler dev` output>
// (a dev server without an email provider logs every email). QALM_E2E_EMAIL picks the address.
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
const signInMode = process.env.QALM_E2E_SIGNIN ?? 'skip';
if (!['skip', 'code', 'link'].includes(signInMode)) throw new Error(`QALM_E2E_SIGNIN must be skip, code or link (got ${signInMode})`);
const serverLog = process.env.QALM_E2E_SERVER_LOG;
if (signInMode !== 'skip' && !(serverLog && existsSync(serverLog))) throw new Error('QALM_E2E_SIGNIN=code|link needs QALM_E2E_SERVER_LOG');
const email = process.env.QALM_E2E_EMAIL ?? `e2e-${Date.now().toString(36)}@example.com`;

/** The newest dev email to `to` in the server log after `from` characters: its app link and 6-digit code. */
function emailFromLog(to, from) {
  const text = readFileSync(serverLog, 'utf8').slice(from);
  const at = text.lastIndexOf(`[email] to=${to} `);
  if (at < 0) return null;
  const body = text.slice(at);
  const link = /(qalm:\/\/auth\/email\/verify\?token=\S+)/.exec(body)?.[1] ?? null;
  const code = /enter this code in qalm: (\d{6})/.exec(body)?.[1] ?? null;
  return link && code ? { link, code } : null;
}
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

  // 1. Library, after the sign-in screen when the build has a server.
  const library = win.getByText('All notebooks').first();
  const skip = win.getByText('Continue without an account').first();
  await library.or(skip).waitFor({ timeout: 60_000 });
  if (await skip.isVisible()) {
    log('sign-in screen at', win.url());
    if (signInMode === 'skip') {
      await skip.click();
      log('continued without an account');
    } else {
      const logStart = readFileSync(serverLog, 'utf8').length;
      await win.getByLabel('Email').first().fill(email);
      await win.getByText('Email me a sign-in link').first().click();
      await win.getByText('Check your email').first().waitFor({ timeout: 20_000 });
      await win.getByText(email).first().waitFor({ timeout: 5_000 });
      let mail = null;
      for (let i = 0; i < 40 && !mail; i++) {
        mail = emailFromLog(email, logStart);
        if (!mail) await win.waitForTimeout(250);
      }
      if (!mail) throw new Error(`no sign-in email to ${email} in ${serverLog}`);
      if (signInMode === 'code') {
        // The sixth digit signs in by itself.
        await win.getByLabel('6-digit code from the email').first().fill(mail.code);
      } else {
        const opener = spawn(exe, [mail.link], { env, stdio: 'ignore' });
        await new Promise((r) => opener.on('exit', r));
      }
      log(`signing in as ${email} with the ${signInMode} from the email`);
    }
  } else if (signInMode !== 'skip') {
    throw new Error('QALM_E2E_SIGNIN is set, but this build has no sign-in screen (no server URL)');
  }
  await library.waitFor({ timeout: 60_000 });
  log('library rendered at', win.url());
  if (signInMode !== 'skip') {
    const signedIn = await win.evaluate(() => !!localStorage.getItem('qalm:tokens'));
    if (!signedIn) throw new Error('the library opened, but no session was stored');
    log('session stored');
  }

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
  if (!['openFile', 'saveFile', 'onDeepLink', 'setFullScreen', 'onFullScreenChange'].every((k) => bridge.keys.includes(k))) throw new Error('bridge incomplete');

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

  // 5b. Fullscreen: F11 (main's before-input-event on Windows/Linux) fills the window and shows the focus pill;
  // Esc leaves it and the header comes back. macOS has no F11: there the toolbar button does it.
  const isFull = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen());
  const waitFull = async (want) => {
    for (let i = 0; i < 40 && (await isFull()) !== want; i++) await win.waitForTimeout(100);
    if ((await isFull()) !== want) throw new Error(`window fullscreen should be ${want}`);
  };
  if (process.platform === 'darwin') await win.getByLabel(/^Full screen/).first().click();
  // A real input event (Playwright's CDP keys skip before-input-event, where main handles F11).
  else await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F11' }));
  await waitFull(true);
  await win.getByLabel(/^Exit full screen/).first().waitFor({ timeout: 10_000 });
  if (await win.getByLabel('Back to library').first().isVisible()) throw new Error('the header should give way to the focus pill');
  writeFileSync(join(tmp, 'fullscreen.png'), await win.screenshot());
  await win.keyboard.press('Escape');
  await waitFull(false);
  await win.getByLabel('Back to library').first().waitFor({ timeout: 10_000 });
  // The toolbar button and the pill's exit button go through the bridge.
  await win.getByLabel(/^Full screen/).first().click();
  await waitFull(true);
  await win.getByLabel(/^Exit full screen/).first().click();
  await waitFull(false);
  log('fullscreen: F11 / button on, Esc / pill off; focus pill and header follow');

  // 6. Export through the native save dialog (stubbed in main).
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: p });
  }, pdfOut);
  await win.getByLabel('Back to library').first().click();
  await win.getByLabel(/^More for /).first().click();
  await win.getByText('Export PDF').first().click();
  // The file can appear before all its bytes are written: wait for a whole PDF (header and trailer).
  const whole = () => {
    if (!existsSync(pdfOut)) return false;
    const b = readFileSync(pdfOut);
    return b.subarray(0, 5).toString('latin1') === '%PDF-' && b.subarray(-32).toString('latin1').includes('%%EOF');
  };
  for (let i = 0; i < 60 && !whole(); i++) await win.waitForTimeout(500);
  if (!existsSync(pdfOut)) throw new Error('export wrote nothing');
  if (!whole()) throw new Error(`export is not a whole PDF (starts ${JSON.stringify(readFileSync(pdfOut).subarray(0, 5).toString('latin1'))})`);
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
