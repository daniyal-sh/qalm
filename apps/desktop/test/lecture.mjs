// Lecture mode end to end on the packaged app (docs/lecture-mode.md): sign in by code against a local server, turn
// lecture mode on (cloud transcription), record a short session from Chromium's fake microphone, draw, erase, pause
// (the pen is locked: drawing changes nothing, a lasso selection's action bar goes, undo is off, image insert is refused,
// the laser still works), resume, draw, stop, with a partial erase while recording (a piece taps back to its stroke),
// play it back (the position moves, tapping a stroke
// seeks), and export a lecture .qalm whose lecture/ folder has the timeline (with the erased stroke's points), audio,
// transcript, crops and LECTURE.md.
//
// Needs a build against a local `wrangler dev --local --var WHISPER_FAKE:1` (no Workers AI call, no remote session):
//   QALM_E2E_SERVER_LOG=<its output> pnpm --filter @qalm/desktop e2e:lecture
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron as electron } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { unzipSync, strFromU8 } = require('fflate');
const { PDFDocument } = require('pdf-lib');
const exe = process.env.QALM_EXE ?? join(here, '..', 'release', 'win-unpacked', 'qalm.exe');
if (!existsSync(exe)) throw new Error(`No packaged app at ${exe}: run \`pnpm --filter @qalm/desktop build\``);
const serverLog = process.env.QALM_E2E_SERVER_LOG;
if (!serverLog || !existsSync(serverLog)) throw new Error('QALM_E2E_SERVER_LOG must point at the wrangler dev output');

const tmp = mkdtempSync(join(tmpdir(), 'qalm-lecture-e2e-'));
const shots = process.env.QALM_E2E_SHOTS ?? tmp;
const pdfIn = join(tmp, 'Lecture.pdf');
const qalmOut = join(tmp, 'lecture.qalm');
{
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  writeFileSync(pdfIn, await doc.save());
}
const email = process.env.QALM_E2E_EMAIL ?? `lecture-${Date.now().toString(36)}@example.com`;
const log = (...a) => console.log('•', ...a);

function codeFromLog(to, from) {
  const text = readFileSync(serverLog, 'utf8').slice(from);
  const at = text.lastIndexOf(`[email] to=${to} `);
  return at < 0 ? null : (/enter this code in qalm: (\d{6})/.exec(text.slice(at))?.[1] ?? null);
}

const env = { ...process.env, QALM_USER_DATA: join(tmp, 'profile') };
delete env.ELECTRON_RUN_AS_NODE;
const errors = [];
const app = await electron.launch({ executablePath: exe, env, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
let ok = false;
try {
  const win = await app.firstWindow();
  win.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
  win.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  const shot = async (name) => writeFileSync(join(shots, name), await win.screenshot());
  const byTest = (id) => win.locator(`[data-testid="${id}"]`).first();

  // 1. Sign in with the emailed code.
  await win.getByText('Continue without an account').first().waitFor({ timeout: 60_000 });
  const logStart = readFileSync(serverLog, 'utf8').length;
  await win.getByLabel('Email').first().fill(email);
  await win.getByText('Email me a sign-in link').first().click();
  await win.getByText('Check your email').first().waitFor({ timeout: 20_000 });
  let code = null;
  for (let i = 0; i < 60 && !code; i++) {
    code = codeFromLog(email, logStart);
    if (!code) await win.waitForTimeout(250);
  }
  if (!code) throw new Error('no sign-in code in the server log');
  await win.getByLabel('6-digit code from the email').first().fill(code);
  await win.getByText('All notebooks').first().waitFor({ timeout: 60_000 });
  log('signed in as', email);

  // 2. Settings → Lecture mode: on, with cloud transcription (the server fakes Whisper).
  await win.getByLabel('Settings', { exact: true }).first().click();
  await win.getByText('Lecture mode').first().click();
  await win.getByRole('switch', { name: 'Lecture mode' }).first().click();
  await win.getByText('Cloud (Whisper)').first().click();
  await win.getByText(/Cloud transcription \(Whisper\): each couple of minutes/).first().waitFor({ timeout: 10_000 });
  await shot('lecture-1-settings.png');
  log('lecture mode on, cloud transcription');
  await win.goBack();
  await win.getByText('All notebooks').first().waitFor({ timeout: 30_000 });

  // 3. A notebook (a one-page PDF, through the stubbed open dialog).
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] });
  }, pdfIn);
  await win.getByText('Import PDF').first().click();
  await win.waitForFunction(() => location.pathname.startsWith('/notebook/'), null, { timeout: 60_000 });
  const ink = win.locator('canvas[style*="crosshair"]').first();
  await ink.waitFor({ timeout: 60_000 });
  await win.waitForTimeout(2500);
  const box = await ink.boundingBox();
  const clip = { x: box.x, y: box.y, width: Math.min(box.width, 700), height: Math.min(box.height, 500) };
  const pageShot = () => win.screenshot({ clip });
  const draw = async (x0, y0, dx = 14, n = 16) => {
    await win.mouse.move(x0, y0);
    await win.mouse.down();
    for (let i = 1; i <= n; i++) await win.mouse.move(x0 + i * dx, y0 + Math.sin(i / 3) * 20);
    await win.mouse.up();
    await win.waitForTimeout(600);
  };
  const A = [box.x + 120, box.y + 120];
  const B = [box.x + 120, box.y + 260];
  const C = [box.x + 120, box.y + 380];
  const D = [box.x + 120, box.y + 190];

  // 4. Record: draw, erase.
  await byTest('lecture-record').click();
  await byTest('lecture-pause').waitFor({ timeout: 20_000 });
  log('recording');
  await win.waitForTimeout(1500);
  await draw(...A);
  await draw(...B);
  await win.getByLabel('Eraser', { exact: true }).first().click();
  await draw(B[0] - 10, B[1], 20, 14); // across stroke B
  await win.getByLabel('Pen', { exact: true }).first().click();
  await win.waitForTimeout(800);
  await shot('lecture-2-recording.png');
  log('drew two strokes and erased one');

  // Partial erase (#68): stroke D, then a few seconds later the eraser in Partial mode across its middle. The
  // timeline logs one erase (D, with its points) and one add (its pieces, `splitFrom` D).
  const secs = (s) => s.split(':').reduce((n, x) => n * 60 + Number(x), 0);
  await draw(...D);
  const tD = secs(await byTest('lecture-time').innerText());
  await win.waitForTimeout(4000);
  await win.getByLabel('Eraser', { exact: true }).first().click();
  await win.getByLabel('Partial', { exact: true }).first().click();
  await win.mouse.move(D[0] + 112, D[1] - 45);
  await win.mouse.down();
  for (let i = 1; i <= 12; i++) await win.mouse.move(D[0] + 112, D[1] - 45 + i * 7.5);
  await win.mouse.up();
  await win.waitForTimeout(800);
  const tE = secs(await byTest('lecture-time').innerText());
  await win.getByLabel('Pen', { exact: true }).first().click();
  log(`partially erased stroke D (written by ${tD} s, erased at ${tE} s)`);

  // A lasso selection made while recording: its action bar must go when the recording pauses (no cut/delete/recolor).
  await win.getByLabel('Lasso select', { exact: true }).first().click();
  await win.mouse.move(A[0] - 30, A[1] - 45);
  await win.mouse.down();
  for (const [x, y] of [[A[0] + 260, A[1] - 45], [A[0] + 260, A[1] + 45], [A[0] - 30, A[1] + 45], [A[0] - 30, A[1] - 40]]) await win.mouse.move(x, y, { steps: 8 });
  await win.mouse.up();
  await win.getByLabel('Deselect', { exact: true }).first().waitFor({ timeout: 10_000 });
  log('lasso selection made (action bar shown)');

  // 5. Pause: the pen is locked, the selection and its action bar go, undo is off.
  await byTest('lecture-pause').click();
  await byTest('lecture-paused-banner').waitFor({ timeout: 10_000 });
  await win.getByLabel('Deselect', { exact: true }).first().waitFor({ state: 'detached', timeout: 5_000 });
  if (await win.getByLabel('Undo', { exact: true }).first().isEnabled()) throw new Error('undo is enabled while paused');
  log('paused: selection bar gone, undo disabled');
  // Inserting an image (like the page actions) is refused while paused.
  await win.getByLabel('Insert image', { exact: true }).first().click();
  await win.getByText('Resume the recording (or close the player) to change the notebook').first().waitFor({ timeout: 5_000 });
  log('paused: insert image refused');
  await win.waitForTimeout(400);
  const before = await pageShot();
  await draw(C[0], C[1]);
  const after = await pageShot();
  await shot('lecture-3-paused.png');
  if (!before.equals(after)) throw new Error('drawing while paused changed the page');
  log('paused: banner shown, drawing does nothing');
  // The laser works while paused (#70): it never writes to the page. K picks it; a stroke shows a trail that fades,
  // and the page's items are unchanged (read as #70's e2e does: select all, copy, read the clip).
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
    return clipItems.map((it) => it.id).sort().join(',');
  };
  const itemsBefore = await pageItems();
  await win.keyboard.press('k');
  const L = [box.x + 420, box.y + 300];
  const laserAt = () =>
    win.evaluate(([x, y]) => {
      const c = document.elementsFromPoint(x, y).find((el) => el instanceof HTMLCanvasElement && el.dataset.qalmInk === '1');
      return Number(c?.dataset.laser ?? 0);
    }, L);
  await win.mouse.move(...L);
  await win.mouse.down();
  for (let i = 1; i <= 12; i++) await win.mouse.move(L[0] + i * 10, L[1] + Math.sin(i / 2) * 15);
  const trail = await laserAt();
  await win.mouse.up();
  if (!trail) throw new Error('laser: no trail while paused');
  await win.waitForTimeout(1500);
  if ((await pageItems()) !== itemsBefore) throw new Error('the laser changed the page while paused');
  log(`paused: the laser works (a trail of ${trail} points), the page is unchanged`);
  const tPaused = await byTest('lecture-time').innerText();
  await win.waitForTimeout(2000);
  if ((await byTest('lecture-time').innerText()) !== tPaused) throw new Error('the clock ran while paused');

  // 6. Resume, draw, let the pen rest so the server makes a crop, stop.
  await byTest('lecture-resume').click();
  await byTest('lecture-pause').waitFor({ timeout: 10_000 });
  await win.getByLabel('Pen', { exact: true }).first().click();
  await win.waitForTimeout(1000);
  await draw(...C);
  await win.waitForTimeout(9000);
  await byTest('lecture-stop').click();
  await byTest('lecture-record').waitFor({ timeout: 30_000 });
  log('stopped at', tPaused, '+ resumed part');
  // The audio chunks are uploaded (tagged with their session): the asset queue empties.
  await win.waitForFunction(() => JSON.parse(localStorage.getItem('qalm:assets:pending') ?? '[]').length === 0, null, { timeout: 30_000 });
  log('audio uploaded (asset queue empty)');
  await win.waitForTimeout(3000); // the last chunk's upload and transcript

  // 7. Play it back: the position moves; tapping stroke A seeks to when it was written.
  await win.getByLabel('More', { exact: true }).first().click();
  await win.getByText(/^Lectures \(1\)/).first().click();
  await byTest('lecture-play-0').click();
  await byTest('lecture-player').waitFor({ timeout: 30_000 });
  await byTest('lecture-playpause').click();
  await win.waitForTimeout(2500);
  const pos1 = await byTest('lecture-position').innerText();
  if (pos1.startsWith('00:00 ')) throw new Error(`playback did not advance (${pos1})`);
  await shot('lecture-4-playing.png');
  await byTest('lecture-playpause').click();
  // Seek to the end (scrubber), then tap stroke C: the position jumps back to when C was written.
  const track = await win.locator('[aria-label="Position"]').first().boundingBox();
  await win.mouse.click(track.x + track.width - 2, track.y + track.height / 2);
  await win.waitForTimeout(500);
  const end = await byTest('lecture-position').innerText();
  await win.mouse.click(C[0] + 50, C[1] + Math.sin(50 / 14 / 3) * 20);
  await win.waitForTimeout(800);
  const tapped = await byTest('lecture-position').innerText();
  if (tapped === end) throw new Error(`tapping stroke C didn't seek (${end})`);
  await shot('lecture-5-tapped.png');
  log(`playback: ${pos1} after 2.5 s; end ${end}; tap on a stroke → ${tapped}`);
  // Tap the left piece of D (partially erased): it seeks to when D was written, not to the erase.
  await win.mouse.click(track.x + track.width - 2, track.y + track.height / 2);
  await win.waitForTimeout(500);
  await win.mouse.click(D[0] + 30, D[1] + Math.sin(30 / 14 / 3) * 20);
  await win.waitForTimeout(800);
  const piece = secs((await byTest('lecture-position').innerText()).split(' / ')[0]);
  if (Math.abs(piece - tD) > 2 || piece > tE - 2) throw new Error(`tapping a piece of D should seek to D's write time (~${tD} s), got ${piece} s (erase at ${tE} s)`);
  log(`playback: tapping a piece of the partially erased stroke → ${piece} s (written ~${tD} s, erased ${tE} s)`);
  await win.getByLabel('Close player').first().click();

  // 8. Export a lecture .qalm (Include lecture recordings).
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: p });
  }, qalmOut);
  await win.getByLabel('More', { exact: true }).first().click();
  await win.getByText('Export .qalm backup').first().click();
  await win.getByRole('switch', { name: 'Include lecture recordings' }).first().click();
  await shot('lecture-6-export.png');
  await byTest('lecture-export-go').click();
  for (let i = 0; i < 60 && !existsSync(qalmOut); i++) await win.waitForTimeout(500);
  await win.waitForTimeout(1000);
  const files = unzipSync(readFileSync(qalmOut));
  const names = Object.keys(files);
  const lec = names.filter((n) => n.startsWith('lecture/'));
  const dir = lec[0]?.split('/').slice(0, 2).join('/');
  if (!dir) throw new Error(`no lecture/ folder in the export: ${names.join(', ')}`);
  const need = ['LECTURE.md', 'session.json', 'timeline.jsonl', 'transcript.json'];
  for (const n of need) if (!files[`${dir}/${n}`]) throw new Error(`missing ${dir}/${n}`);
  const events = strFromU8(files[`${dir}/timeline.jsonl`]).trim().split('\n').map((l) => JSON.parse(l));
  const kinds = events.map((e) => e.k);
  for (const k of ['start', 'base', 'add', 'erase', 'pause', 'resume', 'stop']) if (!kinds.includes(k)) throw new Error(`timeline lacks ${k}: ${kinds.join(',')}`);
  // The partial erase: its pieces were added in one event, each saying which stroke it came from.
  const split = events.find((e) => e.k === 'add' && e.items.some((it) => it.splitFrom));
  if (!split || split.items.filter((it) => it.splitFrom).length < 2) throw new Error('timeline lacks the partial erase pieces (splitFrom)');
  if (!events.some((e) => e.k === 'erase' && e.t === split.t && e.items.some((it) => it.id === split.items[0].splitFrom))) throw new Error('the partial erase should erase the stroke at the same time');
  const erased = events.find((e) => e.k === 'erase');
  if (!erased.items[0]?.points?.length) throw new Error('the erased stroke has no points');
  const audio = lec.filter((n) => n.includes('/audio/'));
  const crops = lec.filter((n) => n.includes('/crops/') && n.endsWith('.png'));
  const transcript = JSON.parse(strFromU8(files[`${dir}/transcript.json`]));
  const session = JSON.parse(strFromU8(files[`${dir}/session.json`]));
  if (audio.length < 2) throw new Error(`expected 2+ audio chunks (before and after the pause), got ${audio.length}`);
  if (!transcript.length) throw new Error('no transcript lines');
  if (!crops.length) throw new Error('no crops');
  const audioBytes = audio.reduce((n, a) => n + files[a].length, 0);
  const cropBytes = crops.reduce((n, a) => n + files[a].length, 0);
  log(`export: ${lec.length} lecture files, ${kinds.length} events (${[...new Set(kinds)].join(',')}), ${audio.length} audio chunks (${audioBytes} B for ${session.durationMs} ms → ${((audioBytes / session.durationMs) * 3.6).toFixed(1)} MB/h), ${crops.length} crops (${cropBytes} B), ${transcript.length} transcript lines`);
  if (errors.length) log(`console errors (not failing):\n  ${errors.join('\n  ')}`);
  ok = true;
} catch (e) {
  console.error(e);
  console.error(`errors so far:\n  ${errors.join('\n  ')}`);
  try {
    writeFileSync(join(tmp, 'failure.png'), await (await app.firstWindow()).screenshot());
  } catch {}
} finally {
  await app.close();
  console.log('artifacts in', tmp);
  if (ok && !process.env.QALM_E2E_KEEP) rmSync(join(tmp, 'profile'), { recursive: true, force: true });
}
console.log(ok ? 'LECTURE E2E PASS' : 'LECTURE E2E FAIL');
process.exit(ok ? 0 : 1);
