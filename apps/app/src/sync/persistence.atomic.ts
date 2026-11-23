// Crash-safe snapshot files, independent of the file API so it can be tested with a fake.
import * as Y from 'yjs';

/** The few file operations the snapshot store needs. `move` requires that `to` does not exist. */
export interface SnapFs {
  exists(name: string): boolean;
  read(name: string): Promise<Uint8Array>;
  /** Creates (or truncates) `name` and writes `bytes`. */
  write(name: string, bytes: Uint8Array): void;
  move(from: string, to: string): void;
  remove(name: string): void;
}

const tmpOf = (name: string) => `${name}.tmp`;
const bakOf = (name: string) => `${name}.bak`;

/**
 * Replaces `name` without ever leaving no good copy: write `name.tmp`, rename `name` → `name.bak`, rename
 * `name.tmp` → `name`, delete `name.bak`. (expo-file-system's `move({ overwrite })` deletes the target first, so it
 * is not atomic.) A crash at any point leaves a complete `name`, or a complete `.tmp`, or the previous `.bak`.
 */
export function writeSnapshot(fs: SnapFs, name: string, bytes: Uint8Array): void {
  const tmp = tmpOf(name);
  const bak = bakOf(name);
  if (fs.exists(tmp)) fs.remove(tmp);
  fs.write(tmp, bytes);
  if (fs.exists(name)) {
    if (fs.exists(bak)) fs.remove(bak);
    fs.move(name, bak);
  }
  fs.move(tmp, name);
  if (fs.exists(bak)) fs.remove(bak);
}

/** A Yjs update that decodes (a `.tmp` may have been cut short by a crash). */
function decodes(bytes: Uint8Array): boolean {
  if (!bytes.length) return false;
  try {
    Y.applyUpdate(new Y.Doc(), bytes);
    return true;
  } catch {
    return false;
  }
}

async function tryRead(fs: SnapFs, name: string): Promise<Uint8Array | null> {
  if (!fs.exists(name)) return null;
  try {
    return await fs.read(name);
  } catch {
    return null;
  }
}

/**
 * Reads `name`; when it is missing or unreadable, falls back to a complete `.tmp` (newest), then `.bak`.
 * `name` and `.bak` are only ever produced by a rename, so they are whole; a `.tmp` is checked first.
 */
export async function readSnapshot(fs: SnapFs, name: string): Promise<Uint8Array | null> {
  const main = await tryRead(fs, name);
  if (main && main.length) return main;
  const tmp = await tryRead(fs, tmpOf(name));
  if (tmp && decodes(tmp)) return tmp;
  const bak = await tryRead(fs, bakOf(name));
  if (bak && bak.length) return bak;
  return null;
}

export function removeSnapshot(fs: SnapFs, name: string): void {
  for (const n of [name, tmpOf(name), bakOf(name)]) if (fs.exists(n)) fs.remove(n);
}

/** Snapshot names among directory entries, including ones that only survive as `.tmp` / `.bak`. */
export function snapshotNames(entries: string[], ext: string): string[] {
  const out = new Set<string>();
  for (const e of entries) {
    const base = e.replace(/\.(tmp|bak)$/, '');
    if (base.endsWith(ext)) out.add(base);
  }
  return [...out];
}
