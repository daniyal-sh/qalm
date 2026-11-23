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

contextBridge.exposeInMainWorld('qalmDesktop', {
  platform: info.platform,
  version: info.version,
  /** Native open dialog. `types` are MIME types or `.ext` (as for pickFile). Null when canceled. */
  openFile: (types: string[]): Promise<{ name: string; mime: string; bytes: Uint8Array } | null> =>
    ipcRenderer.invoke('qalm:open-file', types),
  /** Native save dialog, then writes the bytes. */
  saveFile: (name: string, bytes: Uint8Array, mime: string): Promise<{ saved: boolean }> =>
    ipcRenderer.invoke('qalm:save-file', name, bytes, mime),
  /** In-app route of each qalm:// link (e.g. `/auth/email/verify?token=…`). Returns an unsubscribe. */
  onDeepLink: (cb: (path: string) => void): (() => void) => {
    if (typeof cb !== 'function') throw new TypeError('onDeepLink: callback required');
    listeners.add(cb);
    for (const p of queue.splice(0)) cb(p);
    return () => {
      listeners.delete(cb);
    };
  },
});
