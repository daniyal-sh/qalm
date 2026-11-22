import * as Y from 'yjs';
import { LOCAL_ORIGIN } from '../origin';
import { newId } from '../ids';

export interface Folder { id: string; name: string; createdAt: number }
export interface LibraryEntry {
  id: string; // notebook id
  title: string;
  cover: string;
  folderId: string | null;
  updatedAt: number;
  aiAccess: boolean;
  favorite: boolean;
  deletedAt: number | null;
}

function toMap(o: object): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(o)) if (v !== undefined) m.set(k, v);
  return m;
}

/** Wraps a user's library doc: folders and notebook entries. Fields merge individually across devices. */
export class Library {
  readonly doc: Y.Doc;
  private readonly folderMap: Y.Map<Y.Map<unknown>>;
  private readonly entryMap: Y.Map<Y.Map<unknown>>;

  constructor(doc: Y.Doc) {
    this.doc = doc;
    this.folderMap = doc.getMap('folders');
    this.entryMap = doc.getMap('entries');
  }

  private tx(fn: () => void): void {
    this.doc.transact(fn, LOCAL_ORIGIN);
  }

  folders(): Folder[] {
    return [...this.folderMap.values()].map((m) => m.toJSON() as Folder).sort((a, b) => a.createdAt - b.createdAt);
  }

  addFolder(name: string): string {
    const id = newId();
    this.tx(() => this.folderMap.set(id, toMap({ id, name, createdAt: Date.now() })));
    return id;
  }

  renameFolder(id: string, name: string): void {
    this.tx(() => this.folderMap.get(id)?.set('name', name));
  }

  /** Removes a folder; its notebooks move to the top level. */
  removeFolder(id: string): void {
    this.tx(() => {
      this.folderMap.delete(id);
      this.entryMap.forEach((m) => {
        if (m.get('folderId') === id) m.set('folderId', null);
      });
    });
  }

  /** All entries, including trashed ones (`deletedAt` set). */
  entries(): LibraryEntry[] {
    return [...this.entryMap.values()].map((m) => m.toJSON() as LibraryEntry);
  }

  entry(id: string): LibraryEntry | undefined {
    return this.entryMap.get(id)?.toJSON() as LibraryEntry | undefined;
  }

  /** Adds an entry, or overwrites the given fields of an existing one. */
  putEntry(e: LibraryEntry): void {
    this.tx(() => {
      const m = this.entryMap.get(e.id);
      if (!m) this.entryMap.set(e.id, toMap(e));
      else for (const [k, v] of Object.entries(e)) m.set(k, v);
    });
  }

  updateEntry(id: string, patch: Partial<Omit<LibraryEntry, 'id'>>): void {
    this.tx(() => {
      const m = this.entryMap.get(id);
      if (!m) return;
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) m.set(k, v);
    });
  }

  /** Permanently removes an entry (use `updateEntry(id, { deletedAt })` to trash it). */
  removeEntry(id: string): void {
    this.tx(() => this.entryMap.delete(id));
  }

  observe(cb: (tx: Y.Transaction) => void): () => void {
    const h = (tx: Y.Transaction) => {
      if (tx.changed.size > 0) cb(tx);
    };
    this.doc.on('afterTransaction', h);
    return () => this.doc.off('afterTransaction', h);
  }
}
