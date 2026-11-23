// Web: browser download. In Electron the preload may expose a native save dialog (tech-spec §6).
interface DesktopBridge {
  saveFile?: (name: string, bytes: Uint8Array, mime: string) => Promise<unknown>;
}

export async function saveFile(name: string, mime: string, bytes: Uint8Array): Promise<void> {
  const desktop = (globalThis as { qalmDesktop?: DesktopBridge }).qalmDesktop;
  if (desktop?.saveFile) {
    await desktop.saveFile(name, bytes, mime);
    return;
  }
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
