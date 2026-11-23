// Native: one snapshot file per doc in the documents directory.
import { Directory, File, Paths } from 'expo-file-system';
import type * as Y from 'yjs';

import { SnapshotPersistence, type BytesStorage, type DocPersistence } from './snapshot';

const fileName = (docId: string) => `${encodeURIComponent(docId).replace(/%/g, '_')}.ydoc`;
const docIdOf = (name: string) => decodeURIComponent(name.replace(/\.ydoc$/, '').replace(/_([0-9A-F]{2})/g, '%$1'));

function dir(): Directory {
  const d = new Directory(Paths.document, 'qalm-docs');
  if (!d.exists) d.create({ intermediates: true, idempotent: true });
  return d;
}

export const fileStorage: BytesStorage = {
  async read(docId) {
    const f = new File(dir(), fileName(docId));
    return f.exists ? await f.bytes() : null;
  },
  async write(docId, bytes) {
    const tmp = new File(dir(), `${fileName(docId)}.tmp`);
    if (tmp.exists) tmp.delete();
    tmp.create();
    tmp.write(bytes);
    const target = new File(dir(), fileName(docId));
    if (target.exists) target.delete();
    tmp.move(target);
  },
  async remove(docId) {
    const f = new File(dir(), fileName(docId));
    if (f.exists) f.delete();
  },
  async list() {
    return dir()
      .list()
      .filter((e): e is File => e instanceof File && e.name.endsWith('.ydoc'))
      .map((f) => docIdOf(f.name));
  },
};

export function openPersistence(docId: string, doc: Y.Doc): DocPersistence {
  return new SnapshotPersistence(docId, doc, fileStorage);
}

export const removeLocalDoc = (docId: string) => fileStorage.remove(docId);
export const listLocalDocs = () => fileStorage.list!();
