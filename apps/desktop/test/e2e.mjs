// Smoke test of the packaged app (release/win-unpacked, or QALM_EXE): library renders, PDF import through the
// native open dialog (stubbed in main), drawing with the mouse, reload on a deep route (SPA fallback), PDF export
// through the native save dialog (stubbed), a live shape drawn with a simulated pen (hold to snap, drag to resize, lift,
// undo), the partial eraser splitting a line (undo), scribble to erase (undo), the ruler (a pen stroke snapped straight
// along its edge, moved and turned with the mouse), the laser (a trail that fades and adds nothing), presentation view,
// a qalm:// link handed to a second instance, and no console errors.
//
// A build with a server URL (EXPO_PUBLIC_QALM_SERVER_URL) opens on the sign-in screen with a fresh profile:
//   QALM_E2E_SIGNIN=skip  (default) "Continue without an account"
//   QALM_E2E_SIGNIN=code  sign in with the 6-digit code from the email
//   QALM_E2E_SIGNIN=link  sign in by opening the email's qalm:// link (a second instance hands it over)
// code and link read the email from the server's console: QALM_E2E_SERVER_LOG=<file with `wrangler dev` output>
// (a dev server without an email provider logs every email). QALM_E2E_EMAIL picks the address.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
/** Screenshots of the live-shape step (QALM_E2E_SHOTS keeps them; by default they go with the other artifacts). */
const shots = process.env.QALM_E2E_SHOTS ?? tmp;
mkdirSync(shots, { recursive: true });

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
  // Code mode needs only the code (the server's MAGIC_LINK_URL may point at the web app); link mode needs the qalm:// link.
  return code && (link || signInMode === 'code') ? { link, code } : null;
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
    // Tokens are kept per server (`qalm:tokens@<host>`).
    const signedIn = await win.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith('qalm:tokens')));
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

  // 4b. Live shapes with a simulated pen: draw a wobbly circle, hold, and the clean shape appears before pen-up; drag
  // outward to resize it; lift; the page has one shape; one undo brings the hand-drawn stroke back.
  {
    const cdp = await win.context().newCDPSession(win);
    const pen = (type, x, y) =>
      cdp.send('Input.dispatchMouseEvent', {
        type,
        x,
        y,
        button: type === 'mouseMoved' ? 'none' : 'left',
        buttons: type === 'mouseReleased' ? 0 : penDown ? 1 : 0,
        clickCount: type === 'mouseMoved' ? 0 : 1,
        pointerType: 'pen',
        force: 0.5,
      });
    let penDown = false;
    const shot = (name) => win.screenshot({ clip }).then((b) => writeFileSync(join(shots, name), b));
    const underPen = () => ink.getAttribute('data-shape');
    /** Copies everything on the page (Ctrl+A, Ctrl+C) and reads the clip the app saved: the page's items. */
    const pageItems = async () => {
      await win.evaluate(() => localStorage.removeItem('qalm:clipboard'));
      await win.keyboard.press('Control+a');
      await win.keyboard.press('Control+c');
      let clipItems = null;
      for (let i = 0; i < 40 && !clipItems; i++) {
        clipItems = await win.evaluate(() => JSON.parse(localStorage.getItem('qalm:clipboard') ?? 'null')?.items ?? null);
        if (!clipItems) await win.waitForTimeout(100);
      }
      await win.keyboard.press('Escape');
      if (!clipItems) throw new Error('select all + copy saved no clip');
      return clipItems;
    };
    const R = 70;
    const cx = box.x + box.width * 0.6;
    const cy = box.y + Math.min(box.height, 600) * 0.3;
    const at = (a, r) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    const start = at(-Math.PI / 2, R);
    await pen('mouseMoved', ...start);
    penDown = true;
    await pen('mousePressed', ...start);
    let last = start;
    for (let i = 1; i <= 52; i++) {
      const a = -Math.PI / 2 + (i / 48) * 2 * Math.PI; // a little past the start
      last = at(a, R + Math.sin(i / 3) * 4);
      await pen('mouseMoved', ...last);
      if (i === 30) {
        await shot('shape-1-drawing.png');
        if (await underPen()) throw new Error('snapped while still drawing');
      }
    }
    // Hold: a resting hand wobbles by a pixel or so (well inside 2.5 mm).
    for (let i = 0; i < 6; i++) {
      await win.waitForTimeout(110);
      await pen('mouseMoved', last[0] + (i % 2), last[1] + ((i + 1) % 2));
    }
    let kind = null;
    for (let i = 0; i < 20 && !kind; i++) {
      kind = await underPen();
      if (!kind) await win.waitForTimeout(50);
    }
    if (kind !== 'ellipse') throw new Error(`held a circle; under the pen: ${kind}`);
    await shot('shape-2-held.png');
    log('live shape: a held circle snapped before pen-up');
    // Drag outward: the circle grows about its centre.
    const out = [cx + (last[0] - cx) * 1.6, cy + (last[1] - cy) * 1.6];
    for (let i = 1; i <= 10; i++) await pen('mouseMoved', last[0] + ((out[0] - last[0]) * i) / 10, last[1] + ((out[1] - last[1]) * i) / 10);
    await shot('shape-3-resized.png');
    penDown = false;
    await pen('mouseReleased', ...out);
    await win.waitForTimeout(800);
    await shot('shape-4-placed.png');
    const placed = await pageItems();
    const shapes = placed.filter((it) => it.type === 'shape');
    if (shapes.length !== 1 || shapes[0].kind !== 'ellipse') throw new Error(`after lifting: ${JSON.stringify(placed.map((it) => it.kind ?? it.type))}`);
    const w = Math.hypot(shapes[0].pts[1][0] - shapes[0].pts[0][0], shapes[0].pts[1][1] - shapes[0].pts[0][1]);
    const pxPerUnit = box.width / 612; // the imported PDF page is 612 wide
    if (w * pxPerUnit < 2 * R * 1.4) throw new Error(`the drag did not resize the circle (${(w * pxPerUnit).toFixed(0)} px across)`);
    log(`live shape: one ellipse on the page, ${(w * pxPerUnit).toFixed(0)} px across after the drag (drawn ${2 * R})`);
    await win.keyboard.press('Control+z');
    await win.waitForTimeout(500);
    await shot('shape-5-undone.png');
    const undone = await pageItems();
    if (undone.some((it) => it.type === 'shape') || undone.filter((it) => it.type === 'stroke').length !== placed.length) {
      throw new Error(`after undo: ${JSON.stringify(undone.map((it) => it.kind ?? it.type))}`);
    }
    log('live shape: one undo brought the hand-drawn stroke back; screenshots in', shots);

    // A pen stroke along (x0, y) → (x1, y) in `n` steps (`dy` bends it), then lifted.
    const penLine = async (pts) => {
      await pen('mouseMoved', ...pts[0]);
      penDown = true;
      await pen('mousePressed', ...pts[0]);
      for (const p of pts.slice(1)) await pen('mouseMoved', ...p);
      penDown = false;
      await pen('mouseReleased', ...pts[pts.length - 1]);
      await win.waitForTimeout(600);
    };
    const H = Math.min(box.height, 600);
    const strokesOf = (items) => items.filter((it) => it.type === 'stroke');
    const xRange = (it) => [Math.min(...it.points.map((q) => q.x)), Math.max(...it.points.map((q) => q.x))];

    // 4c. Partial eraser: a pen line, then the eraser in "Partial" mode across its middle splits it in two (style and
    // pressure kept); one undo brings the line back whole.
    await win.keyboard.press('p');
    const ly = box.y + H * 0.82;
    const lx0 = box.x + box.width * 0.2;
    const lx1 = box.x + box.width * 0.5;
    const before4c = await pageItems();
    await win.keyboard.press('p');
    await penLine(Array.from({ length: 31 }, (_, i) => [lx0 + ((lx1 - lx0) * i) / 30, ly]));
    const withLine = await pageItems();
    const lineItem = strokesOf(withLine).find((it) => !before4c.some((b) => b.id === it.id));
    if (!lineItem) throw new Error('the pen line was not added');
    await win.keyboard.press('e');
    await win.getByLabel('Partial', { exact: true }).first().click();
    const ex = (lx0 + lx1) / 2;
    await penLine(Array.from({ length: 11 }, (_, i) => [ex, ly - 30 + i * 6]));
    await shot('erase-1-partial.png');
    const split = await pageItems();
    // Committed at pen-up: the line replaced by two new strokes that say where they came from.
    const pieces = strokesOf(split).filter((it) => !withLine.some((b) => b.id === it.id));
    if (split.some((it) => it.id === lineItem.id) || pieces.length !== 2 || pieces.some((p) => p.splitFrom !== lineItem.id)) {
      throw new Error(`partial erase: expected the line replaced by two pieces, got ${pieces.length} new strokes (line ${split.some((it) => it.id === lineItem.id) ? 'kept' : 'gone'})`);
    }
    const [a4c, b4c] = pieces.map(xRange).sort((p, q) => p[0] - q[0]);
    if (!(a4c[1] < b4c[0]) || pieces.some((p) => p.width !== lineItem.width || p.color !== lineItem.color || p.style !== lineItem.style)) {
      throw new Error(`partial erase: the pieces should keep the line's look and leave a gap (${JSON.stringify([a4c, b4c])})`);
    }
    await win.keyboard.press('Control+z');
    await win.waitForTimeout(500);
    const unsplit = await pageItems();
    const restored = unsplit.find((it) => it.id === lineItem.id);
    if (!restored || unsplit.length !== withLine.length || restored.points.length !== lineItem.points.length) throw new Error('partial erase: one undo should restore the line');
    log(`partial eraser: split the line in two (gap ${((b4c[0] - a4c[1]) * pxPerUnit).toFixed(0)} px), one undo restored it`);
    // Back to whole-stroke mode (the default), so later steps and runs start as a new user would.
    await win.keyboard.press('e');
    await win.getByLabel('Whole stroke', { exact: true }).first().click();

    // 4d. Scribble to erase: a quick zig-zag with the pen over a short stroke deletes it (and isn't kept); one undo
    // brings it back. Back-and-forth over empty paper stays ink.
    await win.keyboard.press('p');
    const sy = box.y + H * 0.66;
    const sx0 = box.x + box.width * 0.62;
    const sx1 = box.x + box.width * 0.78;
    await penLine(Array.from({ length: 21 }, (_, i) => [sx0 + ((sx1 - sx0) * i) / 20, sy + Math.sin(i / 3) * 4]));
    const withTarget = await pageItems();
    const target = strokesOf(withTarget).find((it) => !unsplit.some((b) => b.id === it.id));
    if (!target) throw new Error('scribble: the target stroke was not added');
    await win.keyboard.press('p');
    const zig = [];
    for (let leg = 0; leg <= 10; leg++) {
      const y = sy - 14 + leg * 2.8;
      const [from, to] = leg % 2 ? [sx1 + 8, sx0 - 8] : [sx0 - 8, sx1 + 8];
      for (let k = 0; k < 6; k++) zig.push([from + ((to - from) * k) / 6, y + (2.8 * k) / 6]);
    }
    await penLine(zig);
    await shot('scribble-1-erased.png');
    const scribbled = await pageItems();
    if (scribbled.some((it) => it.id === target.id) || scribbled.length !== withTarget.length - 1) {
      throw new Error(`scribble: expected the target deleted and the scribble not kept (${withTarget.length} → ${scribbled.length} items)`);
    }
    await win.keyboard.press('Control+z');
    await win.waitForTimeout(500);
    const back = await pageItems();
    if (!back.some((it) => it.id === target.id)) throw new Error('scribble: one undo should bring the ink back');
    log('scribble to erase: a zig-zag deleted the stroke under it (scribble not kept), one undo brought it back');

    // 4e. Ruler: R shows it. A wobbly pen stroke starting just outside its top edge, and one starting over the ruler's
    // top half (the ruler hands the pen to the ink underneath), are drawn straight along that edge: every point on
    // one line, half the pen's width outside the edge, pressure kept. The mouse drags it and turns it by its handle
    // (snapping to 45°); R hides it.
    await win.keyboard.press('p');
    await win.keyboard.press('r');
    const rulerEl = win.getByLabel(/^Ruler, \d+°$/).first();
    await rulerEl.waitFor({ timeout: 10_000 });
    const rb = await rulerEl.boundingBox(); // at 0° its box is the strip
    if (!rb || rb.y < box.y || rb.y + rb.height > box.y + H) throw new Error(`the ruler should start over the page (${JSON.stringify(rb)})`);
    const edgeUnits = (rb.y - box.y) / pxPerUnit; // its top edge in page units
    for (const [label, startY] of [
      ['outside its edge', rb.y - 12],
      ['over the ruler', rb.y + 14],
    ]) {
      const known = await pageItems();
      await win.keyboard.press('p');
      const rx0 = rb.x + rb.width * 0.25;
      const rx1 = rb.x + rb.width * 0.6;
      await penLine(Array.from({ length: 25 }, (_, i) => [rx0 + ((rx1 - rx0) * i) / 24, (i ? rb.y - 12 : startY) + Math.sin(i / 2) * 6 - (i % 3)]));
      const along = strokesOf(await pageItems()).find((it) => !known.some((b) => b.id === it.id));
      if (!along) throw new Error(`ruler (${label}): the stroke was not added`);
      const ys = along.points.map((q) => q.y);
      const xs = xRange(along);
      const want = edgeUnits - along.width / 2;
      if (Math.max(...ys) - Math.min(...ys) > 0.01 || Math.abs(ys[0] - want) > 1.5 || (xs[1] - xs[0]) * pxPerUnit < (rx1 - rx0) * 0.9) {
        throw new Error(`ruler (${label}): not straight along the edge (y ${Math.min(...ys).toFixed(2)}–${Math.max(...ys).toFixed(2)}, want ${want.toFixed(2)})`);
      }
      if (!along.points.every((q) => q.p > 0)) throw new Error(`ruler (${label}): pressure lost`);
    }
    // A quick back-and-forth along the ruler, over the line just ruled there, looks like a scribble once snapped to
    // one line: it is ink, and the line stays.
    {
      const known = await pageItems();
      await win.keyboard.press('p');
      const x0 = rb.x + rb.width * 0.25;
      const x1 = rb.x + rb.width * 0.6;
      const back = [];
      for (let leg = 0; leg < 8; leg++) for (let k = 0; k <= 8; k++) back.push([leg % 2 ? x1 - ((x1 - x0) * k) / 8 : x0 + ((x1 - x0) * k) / 8, rb.y - 12 + (k % 3)]);
      await penLine(back);
      const now = await pageItems();
      if (now.length !== known.length + 1 || known.some((b) => !now.some((x) => x.id === b.id))) {
        throw new Error(`ruler: a back-and-forth along it should be kept as ink and erase nothing (${known.length} → ${now.length} items)`);
      }
    }
    await shot('ruler-1-snapped.png');
    log('ruler: pen strokes starting outside its edge and over it were drawn straight along the edge; a back-and-forth along it erased nothing');

    // Holding the ruler with a finger while the pen draws: the finger moves it down 40 px and stays down; the pen
    // starts just outside the moved edge at once (before the pose settles) and follows that edge, not the old one.
    await win.waitForTimeout(2100); // past the pen's hand-side window, so the finger isn't taken for a palm
    const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 7, radiusX: 4, radiusY: 4 }] });
    const hold = [rb.x + rb.width * 0.15, rb.y + rb.height * 0.7];
    await touch('touchStart', ...hold);
    for (let i = 1; i <= 8; i++) await touch('touchMove', hold[0], hold[1] + i * 5);
    const heldBox = await rulerEl.boundingBox();
    if (Math.abs(heldBox.y - (rb.y + 40)) > 2) throw new Error(`ruler: a finger should move it down 40 px (${JSON.stringify(heldBox)})`);
    const knownHeld = await pageItems();
    await win.keyboard.press('p');
    const hy = heldBox.y - 12;
    await penLine(Array.from({ length: 20 }, (_, i) => [rb.x + rb.width * 0.3 + i * 12, hy + Math.sin(i / 2) * 5]));
    // Back where it was, and let go.
    for (let i = 7; i >= 0; i--) await touch('touchMove', hold[0], hold[1] + i * 5);
    await touch('touchEnd');
    const held = strokesOf(await pageItems()).find((it) => !knownHeld.some((b) => b.id === it.id));
    if (!held) throw new Error('ruler (held): the stroke was not added');
    const heldYs = held.points.map((q) => q.y);
    const wantHeld = (heldBox.y - box.y) / pxPerUnit - held.width / 2;
    if (Math.max(...heldYs) - Math.min(...heldYs) > 0.01 || Math.abs(heldYs[0] - wantHeld) > 1.5) {
      throw new Error(`ruler (held): not along the moved edge (y ${heldYs[0].toFixed(2)}, want ${wantHeld.toFixed(2)})`);
    }
    if (Math.abs((await rulerEl.boundingBox()).y - rb.y) > 2) throw new Error('ruler (held): the finger should have moved it back');
    log('ruler: held by a finger and moved, the pen ruled along its new edge before the finger lifted');
    // Drag the body with the mouse (not on the readout or the handles), then turn it clockwise by its handle by about
    // 44°: it snaps to 45° and, falling to the right, reads 135°.
    const grab = [rb.x + rb.width * 0.3, rb.y + rb.height * 0.75];
    await win.mouse.move(...grab);
    await win.mouse.down();
    for (let i = 1; i <= 8; i++) await win.mouse.move(grab[0] + i * 5, grab[1] + i * 10);
    await win.mouse.up();
    const moved = await rulerEl.boundingBox();
    if (Math.abs(moved.y - (rb.y + 80)) > 2 || Math.abs(moved.x - (rb.x + 40)) > 2) throw new Error(`ruler: the mouse should drag it by (40, 80), got ${JSON.stringify(moved)}`);
    const handle = await win.getByLabel('Turn ruler').first().boundingBox();
    const hc = [handle.x + handle.width / 2, handle.y + handle.height / 2];
    const centre = [moved.x + moved.width / 2, moved.y + moved.height / 2];
    const reach = hc[0] - centre[0];
    await win.mouse.move(...hc);
    await win.mouse.down();
    for (let i = 1; i <= 11; i++) {
      const a = (44 * Math.PI) / 180 * (i / 11);
      await win.mouse.move(centre[0] + reach * Math.cos(a), centre[1] + reach * Math.sin(a));
    }
    await win.mouse.up();
    await win.getByLabel('Ruler, 135°').first().waitFor({ timeout: 5_000 });
    await shot('ruler-2-turned.png');
    await win.keyboard.press('r');
    await rulerEl.waitFor({ state: 'detached', timeout: 5_000 });
    log('ruler: the mouse dragged it and turned it by the handle, snapping to 45° (reads 135°); R hid it');

    // 4f. Laser: K picks it; a pen stroke leaves a red trail that fades within about a second, and nothing is added.
    const before4f = await pageItems();
    await win.keyboard.press('k');
    const ly0 = box.y + H * 0.45;
    const lpts = Array.from({ length: 20 }, (_, i) => [box.x + box.width * (0.25 + i * 0.02), ly0 + Math.sin(i / 2) * 25]);
    const laserCount = () =>
      win.evaluate(([x, y]) => {
        const c = document.elementsFromPoint(x, y).find((el) => el instanceof HTMLCanvasElement && el.dataset.qalmInk === '1');
        return Number(c?.dataset.laser ?? 0);
      }, lpts[0]);
    const plain = await win.screenshot({ clip });
    await pen('mouseMoved', ...lpts[0]);
    penDown = true;
    await pen('mousePressed', ...lpts[0]);
    for (const q of lpts.slice(1)) await pen('mouseMoved', ...q);
    penDown = false;
    await pen('mouseReleased', ...lpts[lpts.length - 1]);
    const shown = await laserCount();
    await shot('laser-1-trail.png');
    if (!shown) throw new Error('laser: no trail while drawing');
    await win.waitForTimeout(1300);
    if ((await laserCount()) !== 0) throw new Error('laser: the trail should be gone after about a second');
    const faded = await win.screenshot({ clip });
    if (!faded.equals(plain)) writeFileSync(join(shots, 'laser-2-after.png'), faded);
    // The laser never erases: neither the right mouse button nor the pen's barrel button, across the line from 4c.
    const across = Array.from({ length: 16 }, (_, i) => [lx0 - 20 + ((lx1 - lx0 + 40) * i) / 15, ly + Math.sin(i) * 6]);
    await win.mouse.move(...across[0]);
    await win.mouse.down({ button: 'right' });
    for (const q of across.slice(1)) await win.mouse.move(...q);
    await win.mouse.up({ button: 'right' });
    const barrel = (type, x, y, down) =>
      cdp.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'right', buttons: down ? 2 : 0, clickCount: type === 'mouseMoved' ? 0 : 1, pointerType: 'pen', force: 0.5 });
    await barrel('mouseMoved', ...across[0], false);
    await barrel('mousePressed', ...across[0], true);
    for (const q of across.slice(1)) await barrel('mouseMoved', ...q, true);
    await barrel('mouseReleased', ...across[across.length - 1], false);
    await win.waitForTimeout(1300);
    const after4f = await pageItems();
    if (after4f.length !== before4f.length || before4f.some((b) => !after4f.some((x) => x.id === b.id))) {
      throw new Error(`laser: the page changed (${before4f.length} → ${after4f.length} items)`);
    }
    log(`laser: a trail of ${shown} points faded within 1.3 s and added no item${faded.equals(plain) ? '; the page looks as before' : ''}; right button and barrel button erased nothing`);
    await win.keyboard.press('p');
  }

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

  // 5c. Presentation: F5 hides every control but the page arrows, the laser and Stop; the page is fitted and the window
  // fullscreen; Esc ends it and the header comes back. F5 while typing in a text box neither reloads nor presents.
  {
    await win.evaluate(() => (window.__e2eNoReload = true));
    await win.keyboard.press('t');
    const tb = await win.locator('canvas[data-qalm-ink="1"]').first().boundingBox();
    await win.mouse.click(tb.x + tb.width * 0.5, tb.y + 60);
    await win.keyboard.type('hi');
    await win.keyboard.press('F5');
    await win.waitForTimeout(800);
    const state = await win.evaluate(() => ({ kept: window.__e2eNoReload === true, typing: ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName ?? '') }));
    if (!state.kept) throw new Error('F5 while typing reloaded the page');
    if (await win.getByLabel(/^Stop presenting/).first().isVisible()) throw new Error('F5 while typing should not present');
    if (!state.typing) throw new Error('F5 while typing should leave the text box being typed');
    await win.keyboard.press('Escape');
    await win.keyboard.press('p');
    log('F5 while typing in a text box: no reload, no presentation');
  }
  await win.keyboard.press('F5');
  await win.getByLabel(/^Stop presenting/).first().waitFor({ timeout: 10_000 });
  await waitFull(true);
  if (await win.getByLabel('Back to library').first().isVisible()) throw new Error('presenting should hide the header');
  if (await win.getByLabel(/^Page 1 options/).first().isVisible()) throw new Error('presenting should hide the page controls');
  const pageBox = await win.locator('canvas[data-qalm-ink="1"]').first().boundingBox();
  const winSize = await win.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  if (!pageBox || pageBox.y < 0 || pageBox.y + pageBox.height > winSize.h + 1) throw new Error(`presenting should fit the page (${JSON.stringify(pageBox)} in ${JSON.stringify(winSize)})`);
  writeFileSync(join(tmp, 'present.png'), await win.screenshot());
  await win.keyboard.press('Escape');
  await waitFull(false);
  await win.getByLabel('Back to library').first().waitFor({ timeout: 10_000 });
  log(`presentation: F5 fitted the page (${Math.round(pageBox.height)} of ${winSize.h} px high) without chrome; Esc ended it`);

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
