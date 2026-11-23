import { createNotebookDoc, Notebook, type Library, type LibraryEntry, type NotebookInit, type Paper, type PaperColor, type Size } from '@qalm/core';
import * as Y from 'yjs';

export const PAGE_SIZES = {
  A4: { w: 595, h: 842 },
  Letter: { w: 612, h: 792 },
  A5: { w: 420, h: 595 },
} as const;
export type PageSizeName = keyof typeof PAGE_SIZES;

export function sizeFor(name: PageSizeName, orientation: 'portrait' | 'landscape'): Size {
  const s = PAGE_SIZES[name];
  return orientation === 'landscape' ? { w: s.h, h: s.w } : { w: s.w, h: s.h };
}

export interface NewNotebookForm {
  title: string;
  cover: string;
  paper: Paper;
  paperColor: PaperColor;
  size: PageSizeName;
  orientation: 'portrait' | 'landscape';
  aiAccess: boolean;
}

export function entryFor(meta: { id: string; title: string; cover: string; aiAccess: boolean }, folderId: string | null): LibraryEntry {
  return { id: meta.id, title: meta.title, cover: meta.cover, folderId, updatedAt: Date.now(), aiAccess: meta.aiAccess, favorite: false, deletedAt: null };
}

export const DEFAULT_TITLE = 'Untitled notebook';

/** Builds the index doc for a new notebook (one first page). */
export function buildNotebook(id: string, f: NewNotebookForm): Y.Doc {
  const init: NotebookInit = {
    id,
    title: f.title.trim() || DEFAULT_TITLE,
    cover: f.cover,
    paper: f.paper,
    paperColor: f.paperColor,
    size: sizeFor(f.size, f.orientation),
  };
  const doc = createNotebookDoc(init);
  if (f.aiAccess) new Notebook(doc).setMeta({ aiAccess: true });
  return doc;
}

/** Copies a freshly built doc's state into an opened (persisted / synced) doc. */
export function copyInto(target: Y.Doc, source: Y.Doc): void {
  Y.applyUpdate(target, Y.encodeStateAsUpdate(source));
}

export type LibraryFilter = { kind: 'all' } | { kind: 'favorites' } | { kind: 'trash' } | { kind: 'ai' } | { kind: 'folder'; id: string };

/** Entries for a view, most recently edited first (trash: most recently deleted), with a title search. */
export function visibleEntries(entries: LibraryEntry[], filter: LibraryFilter, query = ''): LibraryEntry[] {
  const q = query.trim().toLowerCase();
  return entries
    .filter((e) => {
      if (filter.kind === 'trash') return !!e.deletedAt;
      if (e.deletedAt) return false;
      if (filter.kind === 'favorites') return e.favorite;
      if (filter.kind === 'folder') return e.folderId === filter.id;
      if (filter.kind === 'ai') return e.aiAccess;
      return true;
    })
    .filter((e) => !q || (e.title || '').toLowerCase().includes(q))
    .sort((a, b) => (filter.kind === 'trash' ? (b.deletedAt ?? 0) - (a.deletedAt ?? 0) : b.updatedAt - a.updatedAt));
}

export function folderCounts(entries: LibraryEntry[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of entries) if (!e.deletedAt && e.folderId) m.set(e.folderId, (m.get(e.folderId) ?? 0) + 1);
  return m;
}

/**
 * Merges the signed-out library into the account's library on sign-in: entries the account
 * doesn't have yet, with their folders (matched by name, created when missing). Returns how many
 * entries were added.
 */
export function mergeLibrary(into: Library, from: Library): number {
  let n = 0;
  into.doc.transact(() => {
    const byName = new Map(into.folders().map((f) => [f.name, f.id]));
    const folderMap = new Map<string, string>();
    for (const f of from.folders()) {
      let id = byName.get(f.name);
      if (!id) {
        id = into.addFolder(f.name);
        byName.set(f.name, id);
      }
      folderMap.set(f.id, id);
    }
    for (const e of from.entries()) {
      if (into.entry(e.id)) continue;
      into.putEntry({ ...e, folderId: e.folderId ? (folderMap.get(e.folderId) ?? null) : null });
      n++;
    }
  });
  return n;
}

export function relativeTime(at: number, now = Date.now()): string {
  const d = Math.max(0, now - at);
  const min = Math.floor(d / 60000);
  if (min < 1) return 'Just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const days = Math.floor(h / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  const date = new Date(at);
  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: date.getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric',
  });
}
