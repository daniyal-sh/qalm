// Web (and Electron): y-indexeddb, one database per doc.
import { IndexeddbPersistence } from 'y-indexeddb';
import type * as Y from 'yjs';

import type { DocPersistence } from './snapshot';

const PREFIX = 'qalm:';

export function openPersistence(docId: string, doc: Y.Doc): DocPersistence {
  const p = new IndexeddbPersistence(PREFIX + docId, doc);
  return {
    whenSynced: p.whenSynced.then(() => undefined),
    // y-indexeddb stores every update as it happens.
    flush: async () => undefined,
    destroy: () => p.destroy(),
  };
}

export async function removeLocalDoc(docId: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(PREFIX + docId);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

export async function listLocalDocs(): Promise<string[]> {
  const dbs = (await indexedDB.databases?.()) ?? [];
  return dbs.map((d) => d.name ?? '').filter((n) => n.startsWith(PREFIX)).map((n) => n.slice(PREFIX.length));
}
