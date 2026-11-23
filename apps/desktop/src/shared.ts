// Pure helpers shared by the main process and the unit tests (no Electron imports).
import * as path from 'node:path';

export const BRAND = {
  name: 'qalm',
  byline: 'by Apollo',
  website: 'https://apollolearn.app',
  systemName: 'qalm',
  appId: 'com.apollo.qalm',
} as const;

/** The origin the web export is served from (custom privileged scheme, not file://). */
export const APP_ORIGIN = 'app://qalm';
export const DEEP_LINK_SCHEME = 'qalm';

/**
 * `qalm://auth/email/verify?token=…` → `/auth/email/verify?token=…` (the same route the web build's
 * magic-link landing uses). Returns null for anything that isn't a qalm: URL.
 */
export function deepLinkToPath(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== `${DEEP_LINK_SCHEME}:`) return null;
  // qalm://auth/x → host "auth", path "/x"; qalm:/auth/x or qalm:///auth/x → path only.
  const joined = `/${u.host}${u.pathname}`.replace(/\/{2,}/g, '/');
  // Normalize (dot segments, encoding) against a fixed base; the result is always a same-origin path.
  const p = new URL(joined + u.search, 'https://qalm.invalid');
  if (p.host !== 'qalm.invalid') return null;
  return p.pathname + p.search;
}

/** The first qalm:// URL in a command line (Windows/Linux pass deep links as argv). */
export function findDeepLink(argv: readonly string[]): string | null {
  return argv.find((a) => a.toLowerCase().startsWith(`${DEEP_LINK_SCHEME}:`)) ?? null;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export const mimeFor = (file: string) => MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';

/**
 * Maps a request path to a file under `root`. Paths that escape the root are rejected (null).
 * `isSpaRoute` is true when the path has no extension: the caller falls back to index.html.
 */
export function resolveWebPath(root: string, urlPath: string): { file: string; isSpaRoute: boolean } | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const rel = decoded.replace(/^\/+/, '') || 'index.html';
  const file = path.resolve(root, rel);
  const rootAbs = path.resolve(root);
  if (file !== rootAbs && !file.startsWith(rootAbs + path.sep)) return null;
  return { file, isSpaRoute: path.extname(rel) === '' };
}

// ---- IPC argument validation ----

const OPEN_FILTERS: Record<string, { name: string; extensions: string[] }> = {
  'application/pdf': { name: 'PDF', extensions: ['pdf'] },
  '.pdf': { name: 'PDF', extensions: ['pdf'] },
  '.qalm': { name: 'qalm notebook', extensions: ['qalm'] },
  'application/x-qalm': { name: 'qalm notebook', extensions: ['qalm'] },
  'image/*': { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
  'image/png': { name: 'PNG', extensions: ['png'] },
  'image/jpeg': { name: 'JPEG', extensions: ['jpg', 'jpeg'] },
};

/** `pickFile(types)` from the app (MIME types or `.ext`) → dialog filters. Unknown types are ignored. */
export function filtersFor(types: unknown): { name: string; extensions: string[] }[] {
  if (!Array.isArray(types) || types.length > 20) throw new Error('openFile: types must be a short array');
  const out: { name: string; extensions: string[] }[] = [];
  for (const t of types) {
    if (typeof t !== 'string' || t.length > 100) throw new Error('openFile: bad type');
    const f = OPEN_FILTERS[t.toLowerCase()];
    if (f && !out.some((o) => o.name === f.name)) out.push(f);
  }
  if (out.length > 1) out.unshift({ name: 'All supported', extensions: [...new Set(out.flatMap((o) => o.extensions))] });
  return out;
}

export interface SaveArgs {
  name: string;
  bytes: Uint8Array;
  mime: string;
}

export const MAX_FILE_BYTES = 1024 * 1024 * 1024; // 1 GB

export function validateSave(name: unknown, bytes: unknown, mime: unknown): SaveArgs {
  if (typeof name !== 'string' || name.length === 0 || name.length > 255) throw new Error('saveFile: bad name');
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_FILE_BYTES) throw new Error('saveFile: bad bytes');
  if (typeof mime !== 'string' || mime.length > 100) throw new Error('saveFile: bad mime');
  // Only a suggested file name: strip any directories and characters Windows forbids.
  const clean = path.basename(name.replace(/\\/g, '/')).replace(/[<>:"|?*\u0000-\u001f]/g, '_') || 'Untitled';
  return { name: clean, bytes, mime };
}

/** The MIME the app expects for an opened file (matches apps/app/src/lib/mime.ts guessMime). */
export function openedMime(name: string): string {
  switch (path.extname(name).toLowerCase()) {
    case '.pdf':
      return 'application/pdf';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    case '.qalm':
      return 'application/x-qalm';
    default:
      return 'application/octet-stream';
  }
}

/** What the right-click menu offers (Windows has no menu bar, so this is the only Cut/Copy/Paste by mouse). */
export type ContextEntry =
  | { kind: 'spelling'; word: string }
  | { kind: 'role'; role: 'cut' | 'copy' | 'paste' | 'selectAll'; enabled: boolean }
  | { kind: 'separator' };

export interface ContextParams {
  isEditable: boolean;
  selectionText: string;
  misspelledWord: string;
  dictionarySuggestions: readonly string[];
  editFlags: { canCut: boolean; canCopy: boolean; canPaste: boolean; canSelectAll: boolean };
}

/**
 * Text fields: spelling suggestions, then Cut/Copy/Paste/Select all. Selected text elsewhere: Copy. Nothing else
 * gets a menu (the page's ink surface uses the right button to erase).
 */
export function contextMenuEntries(p: ContextParams): ContextEntry[] {
  const out: ContextEntry[] = [];
  if (p.isEditable) {
    if (p.misspelledWord) {
      for (const word of p.dictionarySuggestions.slice(0, 5)) out.push({ kind: 'spelling', word });
      if (out.length) out.push({ kind: 'separator' });
    }
    out.push(
      { kind: 'role', role: 'cut', enabled: p.editFlags.canCut },
      { kind: 'role', role: 'copy', enabled: p.editFlags.canCopy },
      { kind: 'role', role: 'paste', enabled: p.editFlags.canPaste },
      { kind: 'separator' },
      { kind: 'role', role: 'selectAll', enabled: p.editFlags.canSelectAll },
    );
  } else if (p.selectionText.trim()) {
    out.push({ kind: 'role', role: 'copy', enabled: true });
  }
  return out;
}
