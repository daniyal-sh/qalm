import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { readSnapshot, removeSnapshot, snapshotNames, writeSnapshot, type SnapFs } from '../src/sync/persistence.atomic';

class Crash extends Error {}

/** In-memory files. After `crashAfter` operations, the next one "kills the app": a write is cut in half, anything else does nothing. */
class FakeFs implements SnapFs {
  files = new Map<string, Uint8Array>();
  ops = 0;
  crashAfter = Infinity;
  private step(): boolean {
    return this.ops++ >= this.crashAfter;
  }
  exists(name: string) {
    return this.files.has(name);
  }
  async read(name: string) {
    const b = this.files.get(name);
    if (!b) throw new Error('ENOENT');
    return b;
  }
  write(name: string, bytes: Uint8Array) {
    if (this.step()) {
      this.files.set(name, bytes.slice(0, Math.floor(bytes.length / 2)));
      throw new Crash();
    }
    this.files.set(name, bytes);
  }
  move(from: string, to: string) {
    if (this.step()) throw new Crash();
    if (this.files.has(to)) throw new Error('EEXIST');
    const b = this.files.get(from);
    if (!b) throw new Error('ENOENT');
    this.files.delete(from);
    this.files.set(to, b);
  }
  remove(name: string) {
    if (this.step()) throw new Crash();
    this.files.delete(name);
  }
}

function snapshot(text: string): Uint8Array {
  const d = new Y.Doc();
  d.getText('t').insert(0, text);
  return Y.encodeStateAsUpdate(d);
}
const textOf = (bytes: Uint8Array | null) => {
  const d = new Y.Doc();
  if (bytes) Y.applyUpdate(d, bytes);
  return d.getText('t').toString();
};

describe('crash-safe snapshot files', () => {
  it('writes, overwrites and cleans up', async () => {
    const fs = new FakeFs();
    writeSnapshot(fs, 'a.ydoc', snapshot('one'));
    writeSnapshot(fs, 'a.ydoc', snapshot('two'));
    expect([...fs.files.keys()]).toEqual(['a.ydoc']);
    expect(textOf(await readSnapshot(fs, 'a.ydoc'))).toBe('two');
    removeSnapshot(fs, 'a.ydoc');
    expect(await readSnapshot(fs, 'a.ydoc')).toBeNull();
  });

  it('a crash between any two steps keeps the old or the new snapshot whole', async () => {
    // Count the steps of a clean overwrite.
    const probe = new FakeFs();
    writeSnapshot(probe, 'a.ydoc', snapshot('old'));
    probe.ops = 0;
    writeSnapshot(probe, 'a.ydoc', snapshot('new'));
    const steps = probe.ops;
    expect(steps).toBeGreaterThanOrEqual(4);

    for (let k = 0; k <= steps; k++) {
      const fs = new FakeFs();
      writeSnapshot(fs, 'a.ydoc', snapshot('old'));
      fs.ops = 0;
      fs.crashAfter = k;
      try {
        writeSnapshot(fs, 'a.ydoc', snapshot('new'));
      } catch (e) {
        expect(e).toBeInstanceOf(Crash);
      }
      fs.crashAfter = Infinity;
      const got = textOf(await readSnapshot(fs, 'a.ydoc'));
      expect(['old', 'new'], `crash after ${k} steps`).toContain(got);
      // The next write recovers fully.
      writeSnapshot(fs, 'a.ydoc', snapshot('next'));
      expect(textOf(await readSnapshot(fs, 'a.ydoc'))).toBe('next');
      expect([...fs.files.keys()]).toEqual(['a.ydoc']);
    }
  });

  it('a crash on the very first write leaves nothing rather than garbage', async () => {
    const fs = new FakeFs();
    fs.crashAfter = 0; // the .tmp write is cut short
    expect(() => writeSnapshot(fs, 'a.ydoc', snapshot('first'))).toThrow(Crash);
    expect(fs.files.has('a.ydoc.tmp')).toBe(true);
    expect(await readSnapshot(fs, 'a.ydoc')).toBeNull();
    // Killed before the rename: the whole .tmp is used.
    const fs2 = new FakeFs();
    fs2.crashAfter = 1;
    expect(() => writeSnapshot(fs2, 'a.ydoc', snapshot('first'))).toThrow(Crash);
    expect(textOf(await readSnapshot(fs2, 'a.ydoc'))).toBe('first');
  });

  it('falls back to .tmp, then .bak, when the main file is missing or unreadable', async () => {
    const fs = new FakeFs();
    fs.files.set('a.ydoc.bak', snapshot('bak'));
    expect(textOf(await readSnapshot(fs, 'a.ydoc'))).toBe('bak');
    fs.files.set('a.ydoc.tmp', snapshot('tmp').slice(0, 3)); // torn
    expect(textOf(await readSnapshot(fs, 'a.ydoc'))).toBe('bak');
    fs.files.set('a.ydoc.tmp', snapshot('tmp'));
    expect(textOf(await readSnapshot(fs, 'a.ydoc'))).toBe('tmp');
    fs.files.set('a.ydoc', new Uint8Array()); // unreadable main
    expect(textOf(await readSnapshot(fs, 'a.ydoc'))).toBe('tmp');
    fs.files.set('a.ydoc', snapshot('main'));
    expect(textOf(await readSnapshot(fs, 'a.ydoc'))).toBe('main');
  });

  it('lists docs that only survive as .tmp or .bak', () => {
    expect(snapshotNames(['a.ydoc', 'b.ydoc.bak', 'c.ydoc.tmp', 'a.ydoc.tmp', 'x.txt'], '.ydoc').sort()).toEqual(['a.ydoc', 'b.ydoc', 'c.ydoc']);
  });
});
