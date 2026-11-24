// The Electron preload's bridge (apps/desktop/src/preload.ts, tech-spec §6). Absent in browsers and on native.
export interface DesktopBridge {
  platform: string;
  version: string;
  openFile: (types: string[]) => Promise<{ name: string; mime: string; bytes: Uint8Array } | null>;
  saveFile: (name: string, bytes: Uint8Array, mime: string) => Promise<{ saved: boolean }>;
  /** A file written in parts, straight to disk (lecture exports). Absent in builds before it. */
  saveStream?: {
    open(name: string, mime: string): Promise<string | null>;
    write(id: string, bytes: Uint8Array): Promise<void>;
    close(id: string, ok: boolean): Promise<{ saved: boolean }>;
  };
  /** Called with the in-app route of each qalm:// link (e.g. `/auth/email/verify?token=…`). */
  onDeepLink: (cb: (path: string) => void) => () => void;
  /** Window fullscreen; resolves to the new state. (Absent in builds older than the fullscreen focus layout.) */
  setFullScreen?: (on: boolean) => Promise<boolean>;
  /** Called with the current state, then on every change (F11, the macOS green button, Esc). Returns an unsubscribe. */
  onFullScreenChange?: (cb: (on: boolean) => void) => () => void;
  /** Lecture mode, macOS: whether Apple's on-device recognizer helper is bundled (absent elsewhere and in older builds). */
  lectureTranscribeAvailable?: (lang: string) => Promise<boolean>;
  /** Lecture mode, macOS: one audio chunk transcribed on the device; segment times relative to the chunk (ms). */
  lectureTranscribe?: (bytes: Uint8Array, mime: string, lang: string) => Promise<import('@qalm/core').TranscriptSegment[]>;
}

export function desktop(): DesktopBridge | null {
  return (globalThis as { qalmDesktop?: DesktopBridge }).qalmDesktop ?? null;
}
