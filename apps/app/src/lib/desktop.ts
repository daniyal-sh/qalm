// The Electron preload's bridge (apps/desktop/src/preload.ts, tech-spec §6). Absent in browsers and on native.
export interface DesktopBridge {
  platform: string;
  version: string;
  openFile: (types: string[]) => Promise<{ name: string; mime: string; bytes: Uint8Array } | null>;
  saveFile: (name: string, bytes: Uint8Array, mime: string) => Promise<{ saved: boolean }>;
  /** Called with the in-app route of each qalm:// link (e.g. `/auth/email/verify?token=…`). */
  onDeepLink: (cb: (path: string) => void) => () => void;
}

export function desktop(): DesktopBridge | null {
  return (globalThis as { qalmDesktop?: DesktopBridge }).qalmDesktop ?? null;
}
