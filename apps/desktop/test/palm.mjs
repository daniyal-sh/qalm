// Palm rejection end to end on the packaged app (release/win-unpacked, or QALM_EXE), with synthetic pen and touch
// input over the DevTools protocol: pen = Input.dispatchMouseEvent with pointerType 'pen'; touch =
// Input.dispatchTouchEvent with radiusX/radiusY as the contact size (CSS px = 0.2646 mm, tech-spec §3).
//
// Checks the rules of modules/qalm-ink/src/InkOverlay.web.tsx: palm size per setting, the 600 ms pen lockout, the
// writing hand's side, a palm resting while the pen writes, a second finger retracting a finger stroke, "pen only"
// (one finger scrolls, two fingers zoom, neither draws, a palm neither draws nor scrolls), "pen and finger" (a finger
// draws, a palm doesn't, two fingers pan and pinch, a late second finger keeps the stroke), the barrel button and the
// right mouse button erasing, the Settings test area's messages, and "draw with" auto-picked once a pen is seen.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron as electron } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const exe =
  process.env.QALM_EXE ??
  (process.platform === 'win32'
    ? join(here, '..', 'release', 'win-unpacked', 'qalm.exe')
    : join(here, '..', 'release', 'mac-universal', 'qalm.app', 'Contents', 'MacOS', 'qalm'));
if (!existsSync(exe)) throw new Error(`No packaged app at ${exe}: run \`pnpm --filter @qalm/desktop build\``);

const tmp = mkdtempSync(join(tmpdir(), 'qalm-palm-'));
const env = { ...process.env, QALM_USER_DATA: join(tmp, 'profile') };
delete env.ELECTRON_RUN_AS_NODE;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MM_PER_PX = 0.2646;
const radius = (mm) => mm / MM_PER_PX / 2;
const FINGER = 9; // mm across: a fingertip, which draws at every setting
const PALM = 30; // a palm at standard and strict

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `  (${detail})` : ''}`);
};

const errors = [];
const app = await electron.launch({ executablePath: exe, env });
try {
  const win = await app.firstWindow();
  win.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  win.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
  const cdp = await win.context().newCDPSession(win);

  const touch = (type, points) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: points.map((p) => ({ x: p.x, y: p.y, id: p.id ?? 0, radiusX: radius(p.mm), radiusY: radius(p.mm), force: 1 })),
    });
  /** One contact (or several moving together) from `from` by (dx, dy) per step. */
  const drag = async (contacts, dx, dy, steps = 10, gapMs = 0) => {
    await touch('touchStart', contacts);
    for (let i = 1; i <= steps; i++) {
      await touch('touchMove', contacts.map((c) => ({ ...c, x: c.x + dx * i, y: c.y + dy * i })));
      if (gapMs) await sleep(gapMs);
    }
    await touch('touchEnd', []);
  };
  const penEvent = (type, x, y, o = {}) =>
    cdp.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: o.button ?? (type === 'mouseMoved' ? 'none' : 'left'),
      buttons: type === 'mouseReleased' ? 0 : (o.buttons ?? (type === 'mouseMoved' && !o.down ? 0 : 1)),
      clickCount: type === 'mouseMoved' ? 0 : 1,
      pointerType: 'pen',
      force: 0.5,
    });
  const penLine = async (x0, y0, x1, y1, o = {}, during) => {
    const n = 16;
    await penEvent('mouseMoved', x0, y0);
    await penEvent('mousePressed', x0, y0, o);
    for (let i = 1; i <= n; i++) {
      await during?.(i);
      await penEvent('mouseMoved', x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, { ...o, down: true });
    }
    await penEvent('mouseReleased', x1, y1, o);
  };
  /** Ink in a clip of the window: pixels darker than the paper, counted in the page itself (no image library). */
  const ink = async (clip) => {
    const png = (await win.screenshot({ clip })).toString('base64');
    return win.evaluate(async (b64) => {
      const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext('2d');
      g.drawImage(bmp, 0, 0);
      const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] < 450) n++;
      return n;
    }, png);
  };
  const setInput = (input) =>
    win.evaluate((input) => {
      const cur = JSON.parse(localStorage.getItem('qalm:prefs') ?? '{}');
      // Setting drawWith here stands for choosing it in Settings (else the first pen would have auto-picked "pen").
      const chosen = input.drawWith ? { drawWithAuto: false } : {};
      localStorage.setItem('qalm:prefs', JSON.stringify({ ...cur, input: { ...(cur.input ?? {}), ...input, ...chosen } }));
    }, input);
  const scrollTops = () =>
    win.evaluate(() =>
      [...document.querySelectorAll('div')]
        .filter((d) => d.scrollHeight > d.clientHeight + 50 && /auto|scroll/.test(getComputedStyle(d).overflowY))
        .reduce((a, d) => a + d.scrollTop, 0),
    );

  const library = win.getByText('All notebooks').first();
  const skip = win.getByText('Continue without an account').first();
  await library.or(skip).waitFor({ timeout: 60_000 });
  if (await skip.isVisible()) await skip.click();
  await library.waitFor({ timeout: 60_000 });

  // ---- Settings test area: the messages ----
  await win.goto('app://qalm/settings');
  await win.getByText('Pen and palm rejection').first().click();
  await win.getByText('Write with a finger or the pen, and rest your palm here').waitFor();
  const pad = await win.locator('canvas').last().boundingBox();
  const px = pad.x + pad.width / 2;
  const py = pad.y + pad.height / 2;
  const message = async () => {
    await sleep(150);
    return (await win.locator('text=/^Ignored|^Strokes here/').last().textContent()) ?? '';
  };
  const choose = async (label) => {
    await win.getByText(label, { exact: true }).first().click();
    await sleep(150);
  };
  const idle = 'Strokes here fade after a few seconds.';

  // ---- Auto-pick: a fresh profile has seen no pen, so fingers draw; the first pen switches to pen only, once ----
  const picked = () => win.locator('text=/Picked automatically|Your choice/').first().textContent();
  check('auto-pick: no pen yet, so pen and finger', /One finger draws.*no pen detected/.test((await picked()) ?? ''), await picked());
  await penEvent('mouseMoved', px - 100, py - 40); // a hovering pen is enough
  await win.getByText('Pen detected: fingers now scroll. Change in Settings.').first().waitFor({ timeout: 5000 }).then(
    () => check('auto-pick: the first pen shows the toast', true),
    () => check('auto-pick: the first pen shows the toast', false),
  );
  check('auto-pick: …and switches to pen only', /only the pen draws.*a pen was detected/.test((await picked()) ?? ''), await picked());
  await sleep(700);
  await drag([{ x: px - 150, y: py - 60, mm: FINGER }], 0, -8, 4);
  check('auto-pick: a finger now scrolls', (await message()) === 'Ignored: only the pen writes (fingers scroll)');
  const stored = await win.evaluate(() => JSON.parse(localStorage.getItem('qalm:prefs') ?? '{}').input);
  check('auto-pick: "pen seen" is saved', stored?.penSeen === true && stored?.drawWith === 'pen' && stored?.drawWithAuto === true, JSON.stringify(stored));

  await choose('Pen and finger');
  check('auto-pick: a choice in Settings wins over the pen', ((await picked()) ?? '').includes('Your choice'), await picked());
  await sleep(2100); // the hovering pen's hand side
  for (const [label, palm, finger, wide] of [
    ['Relaxed · 30 mm', 'relaxed', 12, 35],
    ['Standard · 20 mm', 'standard', 12, 25],
    ['Strict · 14 mm', 'strict', 12, 16],
  ]) {
    await choose(label);
    await drag([{ x: px - 150, y: py, mm: finger }], 12, 2, 8);
    check(`test area, ${palm}: a ${finger} mm finger writes`, (await message()) === idle);
    await drag([{ x: px - 150, y: py, mm: wide }], 12, 2, 8);
    check(`test area, ${palm}: a ${wide} mm contact is a palm`, (await message()) === 'Ignored: looked like a palm');
    await drag([{ x: px - 150, y: py - 20, mm: 8 }], 12, 0, 4); // reset the message
  }
  // A 16 mm flat finger or palm edge writes at standard; strict calls it a palm (checked above).
  await choose('Standard · 20 mm');
  await drag([{ x: px - 150, y: py, mm: 16 }], 12, 2, 8);
  check('test area, standard: a 16 mm flat finger writes', (await message()) === idle);
  await choose('Standard · 20 mm');
  await choose('Right');
  await penLine(px - 60, py - 30, px + 60, py - 30);
  await drag([{ x: px - 250, y: py - 60, mm: FINGER }], 0, 0, 1); // far left and above: only the lockout applies
  check('test area: a finger right after the pen is locked out', (await message()) === 'Ignored: too soon after the pen');
  await sleep(700);
  await drag([{ x: px + 120, y: py + 40, mm: FINGER }], 0, 0, 1);
  check('test area: right hand, a finger right of and below the pen', (await message()) === 'Ignored: on your writing hand’s side');
  await drag([{ x: px - 250, y: py + 40, mm: FINGER }], 8, 0, 4);
  check('test area: right hand, a finger left of the pen writes', (await message()) === idle);
  await choose('Left');
  await penLine(px - 60, py - 30, px + 60, py - 30);
  await sleep(700);
  await drag([{ x: px - 250, y: py + 40, mm: FINGER }], 0, 0, 1);
  check('test area: left hand, a finger left of and below the pen', (await message()) === 'Ignored: on your writing hand’s side');
  await choose('Right');
  await sleep(1500);
  await drag([{ x: px + 120, y: py + 40, mm: FINGER }], 0, 0, 1);
  check('test area: the hand side still holds after 1.5 s', (await message()) === 'Ignored: on your writing hand’s side');
  await sleep(600);
  await drag([{ x: px + 120, y: py + 40, mm: FINGER }], 8, 0, 4);
  check('test area: the hand side expires after 2 s', (await message()) === idle);
  await choose('Pen only');
  await drag([{ x: px, y: py, mm: FINGER }], 0, -8, 4);
  check('test area, pen only: a finger scrolls', (await message()) === 'Ignored: only the pen writes (fingers scroll)');
  await drag([{ x: px, y: py, mm: PALM }], 0, 0, 1);
  check('test area, pen only: a palm is still called a palm', (await message()) === 'Ignored: looked like a palm');

  // ---- Editor ----
  await win.goto('app://qalm/');
  await library.waitFor();
  await win.getByText('New notebook').first().click();
  await win.getByLabel('Title').first().fill('Palm test');
  await win.getByText('Create', { exact: true }).first().click();
  await win.waitForFunction(() => location.pathname.startsWith('/notebook/'), null, { timeout: 30_000 });
  const nbUrl = win.url();
  // QALM_PALM_FULLSCREEN=1: the same checks in the fullscreen focus layout (the window stays fullscreen across pages).
  const fullscreen = process.env.QALM_PALM_FULLSCREEN === '1';
  const setFull = async (on) => {
    await app.evaluate(({ BrowserWindow }, on) => BrowserWindow.getAllWindows()[0].setFullScreen(on), on);
    await win.waitForFunction((on) => (innerWidth === screen.width) === on, on, { timeout: 20_000 });
    await sleep(500);
  };
  if (fullscreen) await setFull(true);
  const open = async (input) => {
    await setInput(input);
    await win.goto(nbUrl);
    await win.locator('canvas[style*="crosshair"]').first().waitFor({ timeout: 60_000 });
    if (fullscreen) await win.getByLabel(/^Exit full screen/).first().waitFor({ timeout: 10_000 });
    await sleep(1500);
  };
  await open({ drawWith: 'any', palm: 'standard', hand: 'right' });
  const box = await win.locator('canvas[style*="crosshair"]').first().boundingBox();
  const vh = await win.evaluate(() => innerHeight);
  const clip = { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, vh - box.y - 4) };
  const cx = clip.x + clip.width / 2;
  const cy = clip.y + clip.height / 2;
  const settle = () => sleep(600);

  // Pen and finger
  let before = await ink(clip);
  let top = 0;
  await drag([{ x: cx - 200, y: cy - 200, mm: FINGER }], 12, 3);
  await settle();
  let after = await ink(clip);
  check('pen and finger: a finger draws', after > before + 50, `${after - before} px`);
  before = after;
  await sleep(700);
  await drag([{ x: cx - 200, y: cy - 120, mm: PALM }], 12, 3);
  await settle();
  after = await ink(clip);
  check('pen and finger: a palm does not draw', Math.abs(after - before) < 20, `${after - before} px`);
  before = after;
  await drag([{ x: cx - 200, y: cy - 60, mm: FINGER }], 12, 0, 8); // a stroke…
  await settle();
  const oneFinger = (await ink(clip)) - before;
  before += oneFinger;
  // …and the same stroke with a second finger landing half way: retracted, and nothing else drawn.
  await touch('touchStart', [{ id: 1, x: cx - 200, y: cy, mm: FINGER }]);
  for (let i = 1; i <= 4; i++) await touch('touchMove', [{ id: 1, x: cx - 200 + i * 12, y: cy, mm: FINGER }]);
  await touch('touchStart', [{ id: 1, x: cx - 152, y: cy, mm: FINGER }, { id: 2, x: cx + 100, y: cy, mm: FINGER }]);
  for (let i = 1; i <= 4; i++) await touch('touchMove', [{ id: 1, x: cx - 152 + i * 12, y: cy, mm: FINGER }, { id: 2, x: cx + 100 + i * 12, y: cy, mm: FINGER }]);
  await touch('touchEnd', []);
  await settle();
  after = await ink(clip);
  check('pen and finger: a second finger retracts the stroke', Math.abs(after - before) < 20, `${after - before} px; a lone stroke is ${oneFinger} px`);
  before = after;
  await penLine(cx - 150, cy + 60, cx + 150, cy + 70);
  await settle();
  after = await ink(clip);
  const penOnly = after - before;
  before = after;
  // The same stroke with a palm landing on the hand side a quarter of the way in and dragging along.
  await penLine(cx - 150, cy + 140, cx + 150, cy + 150, {}, async (i) => {
    const at = { x: cx - 150 + (300 * i) / 16 + 80, y: cy + 230, mm: PALM };
    if (i === 4) await touch('touchStart', [at]);
    else if (i > 4) await touch('touchMove', [at]);
  });
  await touch('touchEnd', []);
  await settle();
  after = await ink(clip);
  const withPalm = after - before;
  check('pen and finger: a palm resting while the pen writes adds no ink', withPalm > penOnly * 0.7 && withPalm < penOnly * 1.3, `${withPalm} px vs ${penOnly} px`);
  before = after;
  // The barrel button held while writing erases that stroke's path, and leaves the pen selected.
  // The selected tool has a filled background (react-native-web doesn't put accessibilityState on a button).
  const filled = (label) => win.evaluate((l) => getComputedStyle(document.querySelector(`[aria-label="${l}"]`)).backgroundColor !== 'rgba(0, 0, 0, 0)', label);
  const penSelected = async () => (await filled('Pen')) && !(await filled('Eraser'));
  await penLine(cx - 170, cy + 65, cx + 170, cy + 65, { button: 'right', buttons: 2 });
  await settle();
  after = await ink(clip);
  check('barrel button: the stroke erases', after < before - penOnly * 0.5, `${after - before} px`);
  check('barrel button: the pen is still the tool afterwards', await penSelected());
  before = after;
  // The right mouse button erases too, without a context menu.
  await win.evaluate(() => {
    window.__menus = 0;
    addEventListener('contextmenu', (e) => setTimeout(() => !e.defaultPrevented && window.__menus++));
  });
  await win.mouse.move(cx - 170, cy + 145);
  await win.mouse.down({ button: 'right' });
  for (let i = 1; i <= 16; i++) await win.mouse.move(cx - 170 + i * 22, cy + 145 + i);
  await win.mouse.up({ button: 'right' });
  await settle();
  after = await ink(clip);
  check('right mouse button: the drag erases', after < before - penOnly * 0.5, `${after - before} px`);
  check('right mouse button: no context menu', (await win.evaluate(() => window.__menus)) === 0);

  // Pen and finger: two fingers pan (with a fling) and pinch; a second finger after a real stroke keeps it.
  const zoom = async () =>
    fullscreen
      ? `${Math.round((await win.locator('canvas[style*="crosshair"]').first().boundingBox()).width)} px wide`
      : (await win.getByLabel('Reset zoom').first().textContent())?.trim();
  const twoFingers = async (a, b, da, db, steps = 10) => {
    await touch('touchStart', [{ id: 1, ...a, mm: FINGER }, { id: 2, ...b, mm: FINGER }]);
    for (let i = 1; i <= steps; i++) {
      await touch('touchMove', [
        { id: 1, x: a.x + da.x * i, y: a.y + da.y * i, mm: FINGER },
        { id: 2, x: b.x + db.x * i, y: b.y + db.y * i, mm: FINGER },
      ]);
      await sleep(16);
    }
    await touch('touchEnd', []);
  };
  await open({ drawWith: 'any' });
  before = await ink(clip);
  top = await scrollTops();
  await twoFingers({ x: cx - 40, y: cy + 150 }, { x: cx + 40, y: cy + 150 }, { x: 0, y: -15 }, { x: 0, y: -15 });
  const panned = (await scrollTops()) - top;
  await sleep(800);
  const flung = (await scrollTops()) - top;
  check('pen and finger: two fingers scroll', panned > 100, `scrolled ${panned} px`);
  check('pen and finger: …with momentum after lifting', flung > panned + 20, `${panned} → ${flung} px`);
  check('pen and finger: …and draw nothing', Math.abs((await ink(clip)) - before) < 40, `${(await ink(clip)) - before} px`);
  await open({ drawWith: 'any' });
  before = await ink(clip);
  const zA = await zoom();
  await twoFingers({ x: cx - 40, y: cy }, { x: cx + 40, y: cy }, { x: -10, y: 0 }, { x: 10, y: 0 });
  await sleep(800);
  const zB = await zoom();
  check('pen and finger: two fingers zoom the page', zB !== zA, `${zA} → ${zB}`);
  check('pen and finger: …and never zoom the whole window', (await win.evaluate(() => visualViewport?.scale ?? 1)) === 1);
  if (fullscreen) await setFull(false);
  await win.getByLabel('Reset zoom').first().click();
  await sleep(800);
  if (fullscreen) {
    await setFull(true);
    await sleep(1000);
  }
  check('pen and finger: pinching draws nothing', Math.abs((await ink(clip)) - before) < 40);
  // A finger that has been drawing for a while, then a second finger: the stroke stays, and the page scrolls.
  await open({ drawWith: 'any' });
  before = await ink(clip);
  top = await scrollTops();
  await touch('touchStart', [{ id: 1, x: cx - 200, y: cy - 150, mm: FINGER }]);
  for (let i = 1; i <= 12; i++) {
    await touch('touchMove', [{ id: 1, x: cx - 200 + i * 15, y: cy - 150 + i * 2, mm: FINGER }]);
    await sleep(25);
  }
  const at = { x: cx - 20, y: cy - 126 };
  for (let i = 0; i <= 10; i++) {
    const pts = [{ id: 1, x: at.x, y: at.y - i * 15, mm: FINGER }, { id: 2, x: at.x + 120, y: at.y - i * 15, mm: FINGER }];
    await touch(i ? 'touchMove' : 'touchStart', pts);
    await sleep(16);
  }
  await touch('touchEnd', []);
  await sleep(800);
  const kept = (await ink(clip)) - before;
  check('pen and finger: a second finger after a real stroke keeps it', kept > 50, `${kept} px`);
  check('pen and finger: …and then scrolls', (await scrollTops()) > top + 50, `scrolled ${(await scrollTops()) - top} px`);

  // Pen only
  await open({ drawWith: 'pen' });
  before = await ink(clip);
  top = await scrollTops();
  await drag([{ x: cx, y: cy + 150, mm: FINGER }], 0, -15, 10, 16);
  await settle();
  after = await ink(clip);
  check('pen only: one finger scrolls', (await scrollTops()) > top + 50, `scrolled ${(await scrollTops()) - top} px`);
  await open({ drawWith: 'pen' });
  before = await ink(clip);
  top = await scrollTops();
  await drag([{ x: cx, y: cy + 150, mm: PALM }], 0, -15, 10, 16);
  await settle();
  check('pen only: a palm does not scroll', (await scrollTops()) === top, `scrolled ${(await scrollTops()) - top} px`);
  check('pen only: a palm does not draw', Math.abs((await ink(clip)) - before) < 20);
  await penLine(cx - 100, cy - 100, cx + 100, cy - 90);
  await drag([{ x: cx, y: cy + 150, mm: FINGER }], 0, -15, 10, 16);
  await settle();
  check('pen only: a finger right after the pen does not scroll', (await scrollTops()) === top, `scrolled ${(await scrollTops()) - top} px`);
  await open({ drawWith: 'pen' });
  before = await ink(clip);
  const z0 = await zoom();
  await touch('touchStart', [{ id: 1, x: cx - 40, y: cy, mm: FINGER }, { id: 2, x: cx + 40, y: cy, mm: FINGER }]);
  for (let i = 1; i <= 10; i++) {
    await touch('touchMove', [{ id: 1, x: cx - 40 - i * 10, y: cy, mm: FINGER }, { id: 2, x: cx + 40 + i * 10, y: cy, mm: FINGER }]);
    await sleep(16);
  }
  await touch('touchEnd', []);
  await sleep(800);
  const z1 = await zoom();
  check('pen only: two fingers zoom the page', z1 !== z0, `${z0} → ${z1}`);
  check('pen only: …and never zoom the whole window', (await win.evaluate(() => visualViewport?.scale ?? 1)) === 1);
  if (fullscreen) await setFull(false);
  await win.getByLabel('Reset zoom').first().click();
  await sleep(800);
  if (fullscreen) {
    await setFull(true);
    await sleep(1000);
  }
  check('pen only: two fingers never draw', Math.abs((await ink(clip)) - before) < 40);

  if (errors.length) console.log(`console errors:\n  ${errors.join('\n  ')}`);
  check('no console errors', errors.length === 0);
} catch (e) {
  console.error(e);
  results.push({ name: 'ran to the end', ok: false });
  try {
    writeFileSync(join(tmp, 'failure.png'), await (await app.firstWindow()).screenshot());
  } catch {}
} finally {
  await app.close();
}
const failed = results.filter((r) => !r.ok);
if (!failed.length) rmSync(tmp, { recursive: true, force: true });
else console.log('artifacts kept in', tmp);
console.log(failed.length ? `PALM FAIL (${failed.length} of ${results.length})` : `PALM PASS (${results.length} checks)`);
process.exit(failed.length ? 1 : 0);
