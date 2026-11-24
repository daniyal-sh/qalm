// Preload (sandboxed): exposes window.qalmDesktop, the only bridge the app uses (apps/app/src/lib/desktop.ts).
import { contextBridge, ipcRenderer } from 'electron';

const info = ipcRenderer.sendSync('qalm:info') as { platform: string; version: string };

// Deep links can arrive before the app subscribes (it boots CanvasKit first): queue them until then.
const queue: string[] = [];
const listeners = new Set<(path: string) => void>();
ipcRenderer.on('qalm:deep-link', (_e, p: unknown) => {
  if (typeof p !== 'string') return;
  if (listeners.size === 0) queue.push(p);
  else for (const l of listeners) l(p);
});

// Window fullscreen changes (F11, the macOS green button, setFullScreen), from main.
const fullScreenListeners = new Set<(on: boolean) => void>();
ipcRenderer.on('qalm:fullscreen', (_e, on: unknown) => {
  if (typeof on === 'boolean') for (const l of fullScreenListeners) l(on);
});

contextBridge.exposeInMainWorld('qalmDesktop', {
  platform: info.platform,
  version: info.version,
  /** Native open dialog. `types` are MIME types or `.ext` (as for pickFile). Null when canceled. */
  openFile: (types: string[]): Promise<{ name: string; mime: string; bytes: Uint8Array } | null> =>
    ipcRenderer.invoke('qalm:open-file', types),
  /** Native save dialog, then writes the bytes. */
  saveFile: (name: string, bytes: Uint8Array, mime: string): Promise<{ saved: boolean }> =>
    ipcRenderer.invoke('qalm:save-file', name, bytes, mime),
  /** A file written in parts: the save dialog (null when cancelled), then each part straight to disk, then close. */
  saveStream: {
    open: (name: string, mime: string): Promise<string | null> => ipcRenderer.invoke('qalm:save-stream-open', name, mime),
    write: (id: string, bytes: Uint8Array): Promise<void> => ipcRenderer.invoke('qalm:save-stream-write', id, bytes),
    close: (id: string, ok: boolean): Promise<{ saved: boolean }> => ipcRenderer.invoke('qalm:save-stream-close', id, ok),
  },
  /** In-app route of each qalm:// link (e.g. `/auth/email/verify?token=…`). Returns an unsubscribe. */
  onDeepLink: (cb: (path: string) => void): (() => void) => {
    if (typeof cb !== 'function') throw new TypeError('onDeepLink: callback required');
    listeners.add(cb);
    for (const p of queue.splice(0)) cb(p);
    return () => {
      listeners.delete(cb);
    };
  },
  /** Lecture mode, macOS: whether Apple's on-device recognizer helper is bundled. */
  lectureTranscribeAvailable: (_lang: string): Promise<boolean> => ipcRenderer.invoke('qalm:lecture-asr-available'),
  /** Lecture mode, macOS: transcribes one audio chunk on the device; segments with times relative to the chunk (ms). */
  lectureTranscribe: (bytes: Uint8Array, mime: string, lang: string): Promise<unknown> => ipcRenderer.invoke('qalm:lecture-transcribe', bytes, mime, lang),
  /** Window fullscreen (BrowserWindow.setFullScreen). Resolves to the new state. */
  setFullScreen: (on: boolean): Promise<boolean> => ipcRenderer.invoke('qalm:set-fullscreen', on === true),
  /** Called with the current state, then on every change. Returns an unsubscribe. */
  onFullScreenChange: (cb: (on: boolean) => void): (() => void) => {
    if (typeof cb !== 'function') throw new TypeError('onFullScreenChange: callback required');
    fullScreenListeners.add(cb);
    void ipcRenderer.invoke('qalm:get-fullscreen').then((on: unknown) => {
      if (typeof on === 'boolean' && fullScreenListeners.has(cb)) cb(on);
    });
    return () => {
      fullScreenListeners.delete(cb);
    };
  },
});
