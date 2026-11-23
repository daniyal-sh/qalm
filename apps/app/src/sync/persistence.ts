// Native: one snapshot file per doc in the documents directory, replaced crash-safely (persistence.atomic.ts).
import { Directory, File, Paths } from 'expo-file-system';
import type * as Y from 'yjs';

import { readSnapshot, removeSnapshot, snapshotNames, writeSnapshot, type SnapFs } from './persistence.atomic';
import { SnapshotPersistence, type BytesStorage, type DocPersistence } from './snapshot';

const EXT = '.ydoc';
const fileName = (docId: string) => `${encodeURIComponent(docId).replace(/%/g, '_')}${EXT}`;
const docIdOf = (name: string) => decodeURIComponent(name.replace(/\.ydoc$/, '').replace(/_([0-9A-F]{2})/g, '%$1'));

function dir(): Directory {
  const d = new Directory(Paths.document, 'qalm-docs');
  if (!d.exists) d.create({ intermediates: true, idempotent: true });
  return d;
}

const fs: SnapFs = {
  exists: (name) => new File(dir(), name).exists,
  read: (name) => new File(dir(), name).bytes(),
  write(name, bytes) {
    const f = new File(dir(), name);
    f.create({ overwrite: true });
    f.write(bytes);
  },
  move: (from, to) => new File(dir(), from).move(new File(dir(), to)),
  remove: (name) => new File(dir(), name).delete(),
};

export const fileStorage: BytesStorage = {
  read: async (docId) => readSnapshot(fs, fileName(docId)),
  write: async (docId, bytes) => writeSnapshot(fs, fileName(docId), bytes),
  remove: async (docId) => removeSnapshot(fs, fileName(docId)),
  async list() {
    const names = dir()
      .list()
      .filter((e): e is File => e instanceof File)
      .map((f) => f.name);
    return snapshotNames(names, EXT).map(docIdOf);
  },
};

export function openPersistence(docId: string, doc: Y.Doc): DocPersistence {
  return new SnapshotPersistence(docId, doc, fileStorage);
}

export const removeLocalDoc = (docId: string) => fileStorage.remove(docId);
export const listLocalDocs = () => fileStorage.list!();
