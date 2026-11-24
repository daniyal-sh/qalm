// Electron main process for qalm (tech-spec §6): serves the app's web export over app://qalm,
// native open/save dialogs over IPC, qalm:// deep links (email magic-link sign-in), window state.
import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, screen, session, shell, type MenuItemConstructorOptions } from 'electron';
import { promises as fs, cpSync, createWriteStream, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  APP_ORIGIN,
  BRAND,
  DEEP_LINK_SCHEME,
  MAX_FILE_BYTES,
  contextMenuEntries,
  deepLinkToPath,
  filtersFor,
  findDeepLink,
  isFullScreenToggle,
  mimeFor,
  openedMime,
  resolveWebPath,
  validateSave,
} from './shared';

// Optional: point at the Expo web dev server (`pnpm --filter @qalm/app web`), e.g. http://localhost:8081.
const DEV_URL = process.env.QALM_DEV_URL?.replace(/\/+$/, '') || null;
const DEV_ORIGIN = DEV_URL ? new URL(DEV_URL).origin : null;

function webRoot(): string {
  if (process.env.QALM_WEB_DIR) return path.resolve(process.env.QALM_WEB_DIR);
  if (app.isPackaged) return path.join(process.resourcesPath, 'web');
  return path.resolve(__dirname, '..', '..', 'app', 'dist');
}

app.setName(BRAND.systemName);
// Tests run against a throwaway profile.
if (process.env.QALM_USER_DATA) app.setPath('userData', path.resolve(process.env.QALM_USER_DATA));
else moveLegacyUserData();

/**
 * The app was named "Apollo Qalm" in early builds; carry its notebooks (web storage) and window state over once.
 * Electron creates the new userData folder before this runs, so copy the stores in (nothing has opened them yet)
 * rather than renaming the folder, then remove the old one so this happens only once.
 */
function moveLegacyUserData() {
  try {
    const legacy = path.join(app.getPath('appData'), 'Apollo Qalm');
    const current = app.getPath('userData');
    if (legacy === current || !existsSync(legacy)) return;
    for (const name of ['Local Storage', 'IndexedDB', 'WebStorage', 'window-state.json']) {
      const from = path.join(legacy, name);
      if (!existsSync(from)) continue;
      const to = path.join(current, name);
      rmSync(to, { recursive: true, force: true });
      cpSync(from, to, { recursive: true });
    }
    rmSync(legacy, { recursive: true, force: true });
  } catch {
    // Best effort: a fresh profile is still a working app, and the old folder is kept if anything failed above.
  }
}
if (process.platform === 'win32') app.setAppUserModelId(BRAND.appId);

// Must run before `ready`: app:// behaves like https (fetch, workers, wasm streaming, storage, secure context).
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true, corsEnabled: true },
  },
]);

let win: BrowserWindow | null = null;
// A deep link that arrived before the window could take it (cold start, or macOS open-url before ready).
let pendingLink: string | null = findDeepLink(process.argv);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  start();
}

function start() {
  // Register qalm:// (Windows registry / macOS LaunchServices). In dev the app is `electron <dir>`.
  if (process.defaultApp && process.argv[1]) {
    app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
  }

  app.on('second-instance', (_e, argv) => {
    const link = findDeepLink(argv);
    if (link) handleDeepLink(link);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  // macOS delivers deep links here, possibly before `ready`.
  app.on('open-url', (e, url) => {
    e.preventDefault();
    handleDeepLink(url);
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('activate', () => {
    if (app.isReady() && BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  void app.whenReady().then(() => {
    registerAppProtocol();
    registerIpc();
    lockDownSession();
    // No menu bar in the window on Windows/Linux (editing shortcuts still work in Chromium). macOS keeps its
    // system menu bar, which Cmd+C/V/Q and the app menu depend on.
    Menu.setApplicationMenu(process.platform === 'darwin' ? buildMenu() : null);
    createWindow();
  });
}

// ---------- app:// protocol ----------

function registerAppProtocol() {
  const root = webRoot();
  protocol.handle('app', async (req) => {
    const url = new URL(req.url);
    if (url.host !== 'qalm') return new Response('Not found', { status: 404 });
    const hit = resolveWebPath(root, url.pathname);
    if (!hit) return new Response('Forbidden', { status: 403 });
    let file = hit.file;
    if (!existsSync(file) || (await fs.stat(file)).isDirectory()) {
      // SPA fallback: client routes like /notebook/abc are served index.html; missing assets are 404s.
      if (!hit.isSpaRoute) return new Response('Not found', { status: 404 });
      file = path.join(root, 'index.html');
    }
    try {
      const body = await fs.readFile(file);
      return new Response(body, { headers: { 'content-type': mimeFor(file), 'cache-control': 'no-cache' } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

// ---------- window ----------

interface WinState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
}

const statePath = () => path.join(app.getPath('userData'), 'window-state.json');

function loadState(): WinState {
  const fallback: WinState = { width: 1280, height: 860 };
  try {
    const s = JSON.parse(readFileSync(statePath(), 'utf8')) as WinState;
    if (!(s.width >= 400 && s.height >= 300)) return fallback;
    // Only restore the position if it is still on a connected display.
    if (typeof s.x === 'number' && typeof s.y === 'number') {
      const d = screen.getDisplayMatching({ x: s.x, y: s.y, width: s.width, height: s.height }).workArea;
      const visible = s.x < d.x + d.width - 50 && s.x + s.width > d.x + 50 && s.y >= d.y - 10 && s.y < d.y + d.height - 50;
      if (!visible) return { width: s.width, height: s.height, maximized: s.maximized };
    }
    return s;
  } catch {
    return fallback;
  }
}

function saveState(w: BrowserWindow) {
  try {
    const b = w.getNormalBounds();
    writeFileSync(statePath(), JSON.stringify({ ...b, maximized: w.isMaximized() } satisfies WinState));
  } catch {
    /* best effort */
  }
}

function startUrl(): string {
  const p = pendingLink ? deepLinkToPath(pendingLink) : null;
  pendingLink = null;
  return `${DEV_URL ?? APP_ORIGIN}${p ?? '/'}`;
}

function createWindow() {
  const st = loadState();
  const w = new BrowserWindow({
    x: st.x,
    y: st.y,
    width: st.width,
    height: st.height,
    minWidth: 400,
    minHeight: 300,
    title: BRAND.systemName,
    backgroundColor: '#f3f3f5',
    show: false,
    icon: app.isPackaged ? undefined : iconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: true,
      // Lecture mode keeps recording (and rotating audio chunks) while the window is minimised.
      backgroundThrottling: false,
    },
  });
  win = w;
  if (st.maximized) w.maximize();
  w.once('ready-to-show', () => w.show());
  w.on('page-title-updated', (e) => e.preventDefault());
  w.on('close', () => saveState(w));
  w.on('closed', () => {
    if (win === w) win = null;
  });

  // Links: anything off our origin goes to the system browser; the window never navigates away.
  w.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (e, url) => {
    if (!isOwnUrl(url)) {
      e.preventDefault();
      openExternalSafe(url);
    }
  });
  w.webContents.on('will-attach-webview', (e) => e.preventDefault());
  w.webContents.on('context-menu', (_e, params) => showContextMenu(w, params));

  // Fullscreen: F11 on Windows/Linux (no menu bar there); macOS has View > Enter Full Screen (Ctrl+Cmd+F) and the
  // green button. However the window gets there, the app hears about it and shows (or leaves) its focus layout.
  w.webContents.on('before-input-event', (e, input) => {
    if (!isFullScreenToggle(input, process.platform)) return;
    e.preventDefault();
    w.setFullScreen(!w.isFullScreen());
  });
  w.on('enter-full-screen', () => w.webContents.send('qalm:fullscreen', true));
  w.on('leave-full-screen', () => w.webContents.send('qalm:fullscreen', false));

  void w.loadURL(startUrl());
}

/** Right-click in a text field: spelling suggestions and Cut/Copy/Paste (Windows has no menu bar to find them in). */
function showContextMenu(w: BrowserWindow, params: Electron.ContextMenuParams) {
  const template: MenuItemConstructorOptions[] = contextMenuEntries(params).map((e) =>
    e.kind === 'separator'
      ? { type: 'separator' }
      : e.kind === 'spelling'
        ? { label: e.word, click: () => w.webContents.replaceMisspelling(e.word) }
        : { role: e.role, enabled: e.enabled },
  );
  if (template.length) Menu.buildFromTemplate(template).popup({ window: w });
}

function iconPath(): string | undefined {
  const p = path.resolve(__dirname, '..', 'resources', 'icons', 'icon.png');
  return existsSync(p) ? p : undefined;
}

function isOwnUrl(url: string): boolean {
  try {
    const u = new URL(url);
    // Node's URL reports origin "null" for custom schemes, so compare scheme and host for app://.
    return DEV_ORIGIN ? u.origin === DEV_ORIGIN : u.protocol === 'app:' && u.host === 'qalm';
  } catch {
    return false;
  }
}

function openExternalSafe(url: string) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:') void shell.openExternal(u.href);
  } catch {
    /* ignore */
  }
}

function lockDownSession() {
  const ses = session.defaultSession;
  // No camera, location or notifications; clipboard writes go through the Edit menu / execCommand. The microphone
  // (audio only, never video) is for lecture recording, from our own pages.
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    if (permission === 'media') {
      const types = (details as { mediaTypes?: string[] }).mediaTypes ?? [];
      return cb(isOwnUrl(wc.getURL()) && types.length > 0 && types.every((t) => t === 'audio'));
    }
    cb(permission === 'clipboard-sanitized-write' || permission === 'fullscreen');
  });
}

// ---------- deep links ----------

function handleDeepLink(raw: string) {
  const p = deepLinkToPath(raw);
  if (!p) return;
  if (!win || win.webContents.isLoading()) {
    if (!win) {
      pendingLink = raw;
      if (app.isReady()) createWindow();
      return;
    }
    // Still loading: navigate straight to the route, like the web build's magic-link landing.
    void win.loadURL(`${DEV_URL ?? APP_ORIGIN}${p}`);
  } else {
    win.webContents.send('qalm:deep-link', p);
  }
  if (win.isMinimized()) win.restore();
  win.focus();
}

// ---------- IPC (validated) ----------

/** The macOS speech helper, if this build has one (it is built only on a Mac: native/mac-transcribe). */
function macTranscriber(): string | null {
  if (process.platform !== 'darwin') return null;
  const p = app.isPackaged ? path.join(process.resourcesPath, 'mac-transcribe') : path.resolve(__dirname, '..', 'native', 'mac-transcribe', 'build', 'mac-transcribe');
  return existsSync(p) ? p : null;
}

function senderOk(e: Electron.IpcMainInvokeEvent): boolean {
  return !!e.senderFrame && isOwnUrl(e.senderFrame.url);
}

function registerIpc() {
  ipcMain.handle('qalm:open-file', async (e, types: unknown) => {
    if (!senderOk(e)) throw new Error('forbidden');
    const filters = filtersFor(types);
    const parent = BrowserWindow.fromWebContents(e.sender);
    const opts: Electron.OpenDialogOptions = { properties: ['openFile'], filters };
    const r = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
    const file = r.filePaths[0];
    if (r.canceled || !file) return null;
    const st = await fs.stat(file);
    if (st.size > MAX_FILE_BYTES) throw new Error('That file is too large to open');
    const bytes = new Uint8Array(await fs.readFile(file));
    const name = path.basename(file);
    return { name, mime: openedMime(name), bytes };
  });

  ipcMain.handle('qalm:save-file', async (e, name: unknown, bytes: unknown, mime: unknown) => {
    if (!senderOk(e)) throw new Error('forbidden');
    const a = validateSave(name, bytes, mime);
    const ext = path.extname(a.name).slice(1);
    const parent = BrowserWindow.fromWebContents(e.sender);
    const opts: Electron.SaveDialogOptions = {
      defaultPath: path.join(app.getPath('documents'), a.name),
      filters: ext ? [{ name: ext.toUpperCase(), extensions: [ext] }, { name: 'All files', extensions: ['*'] }] : [],
    };
    const r = parent ? await dialog.showSaveDialog(parent, opts) : await dialog.showSaveDialog(opts);
    if (r.canceled || !r.filePath) return { saved: false };
    // Write next to the target and rename over it, so a failed write never leaves a half-written file (or a
    // truncated copy of the one being replaced).
    const tmp = `${r.filePath}.${process.pid}.tmp`;
    try {
      await fs.writeFile(tmp, a.bytes);
      await fs.rename(tmp, r.filePath);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
    return { saved: true };
  });

  // A file written in parts (a lecture export, which can be hundreds of MB): the save dialog first, then each part
  // goes straight to disk, so neither process holds the whole file. Written next to the target and renamed over it
  // at the end; a failed or cancelled export leaves nothing behind.
  const streams = new Map<string, { out: ReturnType<typeof createWriteStream>; tmp: string; target: string; sender: number }>();
  ipcMain.handle('qalm:save-stream-open', async (e, name: unknown, mime: unknown) => {
    if (!senderOk(e)) throw new Error('forbidden');
    const a = validateSave(name, new Uint8Array(0), mime);
    const ext = path.extname(a.name).slice(1);
    const parent = BrowserWindow.fromWebContents(e.sender);
    const opts: Electron.SaveDialogOptions = {
      defaultPath: path.join(app.getPath('documents'), a.name),
      filters: ext ? [{ name: ext.toUpperCase(), extensions: [ext] }, { name: 'All files', extensions: ['*'] }] : [],
    };
    const r = parent ? await dialog.showSaveDialog(parent, opts) : await dialog.showSaveDialog(opts);
    if (r.canceled || !r.filePath) return null;
    const id = randomUUID();
    const tmp = `${r.filePath}.${process.pid}.${id.slice(0, 8)}.tmp`;
    streams.set(id, { out: createWriteStream(tmp), tmp, target: r.filePath, sender: e.sender.id });
    e.sender.once('destroyed', () => void closeStream(id, false));
    return id;
  });
  ipcMain.handle('qalm:save-stream-write', async (e, id: unknown, bytes: unknown) => {
    if (!senderOk(e)) throw new Error('forbidden');
    const s = typeof id === 'string' ? streams.get(id) : undefined;
    if (!s || s.sender !== e.sender.id) throw new Error('saveStream: unknown stream');
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > 64 * 1024 * 1024) throw new Error('saveStream: bad part');
    await new Promise<void>((resolve, reject) => s.out.write(bytes, (err) => (err ? reject(err) : resolve())));
  });
  const closeStream = async (id: string, ok: boolean): Promise<boolean> => {
    const s = streams.get(id);
    if (!s) return false;
    streams.delete(id);
    await new Promise<void>((resolve) => s.out.end(() => resolve()));
    if (ok) {
      try {
        await fs.rename(s.tmp, s.target);
        return true;
      } catch {
        /* falls through to the cleanup */
      }
    }
    await fs.rm(s.tmp, { force: true }).catch(() => undefined);
    return false;
  };
  ipcMain.handle('qalm:save-stream-close', async (e, id: unknown, ok: unknown) => {
    if (!senderOk(e)) throw new Error('forbidden');
    const s = typeof id === 'string' ? streams.get(id) : undefined;
    if (!s || s.sender !== e.sender.id) return { saved: false };
    return { saved: await closeStream(id as string, ok === true) };
  });

  ipcMain.handle('qalm:set-fullscreen', (e, on: unknown) => {
    if (!senderOk(e)) throw new Error('forbidden');
    if (typeof on !== 'boolean') throw new Error('setFullScreen: on must be a boolean');
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w) return false;
    w.setFullScreen(on);
    return w.isFullScreen();
  });
  ipcMain.handle('qalm:get-fullscreen', (e) => {
    if (!senderOk(e)) throw new Error('forbidden');
    return BrowserWindow.fromWebContents(e.sender)?.isFullScreen() ?? false;
  });

  // Lecture mode on macOS: Apple's on-device recognizer through a small helper (native/mac-transcribe), when bundled.
  ipcMain.handle('qalm:lecture-asr-available', (e) => {
    if (!senderOk(e)) throw new Error('forbidden');
    return !!macTranscriber();
  });
  ipcMain.handle('qalm:lecture-transcribe', async (e, bytes: unknown, mime: unknown, lang: unknown) => {
    if (!senderOk(e)) throw new Error('forbidden');
    const bin = macTranscriber();
    if (!bin) throw new Error('No on-device recognizer');
    if (!(bytes instanceof Uint8Array) || bytes.length > 16 * 1024 * 1024) throw new Error('lectureTranscribe: bad audio');
    // The renderer sends WAV (decoded from MediaRecorder's WebM/Opus, which AVFoundation can't read).
    if (typeof mime !== 'string' || !/^audio\/(wav|x-wav|mp4|aac)\b/.test(mime)) throw new Error('lectureTranscribe: send WAV (or AAC)');
    const ext = /wav/.test(mime) ? 'wav' : 'm4a';
    const file = path.join(os.tmpdir(), `qalm-lecture-${process.pid}-${Date.now()}.${ext}`);
    await fs.writeFile(file, bytes);
    try {
      const out = await new Promise<string>((resolve, reject) =>
        execFile(bin, [file, typeof lang === 'string' && /^[A-Za-z-]{0,16}$/.test(lang) ? lang : ''], { timeout: 5 * 60_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) =>
          err ? reject(err) : resolve(stdout),
        ),
      );
      return JSON.parse(out) as unknown;
    } finally {
      await fs.rm(file, { force: true }).catch(() => undefined);
    }
  });

  ipcMain.on('qalm:info', (e) => {
    e.returnValue = { platform: process.platform, version: app.getVersion() };
  });
}

// ---------- menu ----------

/** macOS only; Windows and Linux windows have no menu bar. */
function buildMenu(): Menu {
  const template: MenuItemConstructorOptions[] = [
    { role: 'appMenu', label: BRAND.name },
    { label: 'File', submenu: [{ role: 'close' }] },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [{ label: `About ${BRAND.name}`, click: () => void shell.openExternal(BRAND.website) }],
    },
  ];
  return Menu.buildFromTemplate(template);
}
