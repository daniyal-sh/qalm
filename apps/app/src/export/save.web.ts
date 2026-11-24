// Web: browser download. In Electron the preload exposes a native save dialog (tech-spec §6).
import { desktop } from '../lib/desktop';

export async function saveFile(name: string, mime: string, bytes: Uint8Array): Promise<void> {
  const d = desktop();
  if (d) {
    await d.saveFile(name, bytes, mime);
    return;
  }
  download(name, new Blob([bytes as BlobPart], { type: mime }));
}

/**
 * Like `saveFile`, for a file made in parts (a lecture export). The desktop app asks where to save first, then each
 * part goes straight to disk (nothing is held whole). In a browser the parts become a Blob directly (never copied
 * into one array).
 */
export async function saveFileStream(name: string, mime: string, write: (out: (part: Uint8Array) => Promise<void>) => Promise<void>): Promise<void> {
  const d = desktop();
  if (d?.saveStream) {
    const s = d.saveStream;
    const id = await s.open(name, mime);
    if (!id) return; // cancelled
    try {
      await write((p) => s.write(id, p));
    } catch (e) {
      await s.close(id, false).catch(() => undefined);
      throw e;
    }
    await s.close(id, true);
    return;
  }
  const parts: Uint8Array[] = [];
  await write(async (p) => void parts.push(p));
  if (d) {
    const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (let i = 0; i < parts.length; i++) {
      all.set(parts[i]!, at);
      at += parts[i]!.length;
      parts[i] = new Uint8Array(0); // let each part go as soon as it is copied
    }
    await d.saveFile(name, all, mime);
    return;
  }
  download(name, new Blob(parts as BlobPart[], { type: mime }));
}

function download(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
