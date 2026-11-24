import * as Y from 'yjs';
import { LOCAL_ORIGIN } from '../origin';
import { newId } from '../ids';
import { normalizeColor } from '../geometry/color';
import type { LectureSummary } from '../lecture/types';

/** Which swatch list: text and shapes use the pen list. */
export type SwatchTool = 'pen' | 'highlighter';
/** At most this many saved colours per tool. */
export const MAX_SWATCHES = 24;
/** The brand palettes (brand.md): what a library shows until the user changes its swatches. */
export const DEFAULT_SWATCHES: Record<SwatchTool, readonly string[]> = {
  pen: ['#27272a', '#4338ca', '#1d4ed8', '#0f766e', '#b91c1c', '#b45309'],
  highlighter: ['#fde68a', '#bfdbfe', '#bbf7d0', '#fbcfe8'],
};

/** Pens are opaque: an alpha on a pen colour is dropped. */
function swatchColor(tool: SwatchTool, c: string): string | null {
  const n = normalizeColor(c);
  return n && tool === 'pen' ? n.slice(0, 7) : n;
}

function dedupe(tool: SwatchTool, list: readonly string[]): string[] {
  const out: string[] = [];
  for (const c of list) {
    const n = swatchColor(tool, c);
    if (n && !out.includes(n)) out.push(n);
  }
  return out.slice(0, MAX_SWATCHES);
}

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
  private readonly swatchMap: Y.Map<Y.Array<string>>;

  constructor(doc: Y.Doc) {
    this.doc = doc;
    this.folderMap = doc.getMap('folders');
    this.entryMap = doc.getMap('entries');
    this.swatchMap = doc.getMap('swatches');
    this.lectureMap = doc.getMap('lectures');
  }

  private readonly lectureMap: Y.Map<LectureSummary>;

  /** Lecture sessions (docs/lecture-mode.md §5), newest first; `notebookId` filters to one notebook. */
  lectures(notebookId?: string): LectureSummary[] {
    const out: LectureSummary[] = [];
    this.lectureMap.forEach((v) => {
      if (v && typeof v === 'object' && typeof v.id === 'string' && (!notebookId || v.notebookId === notebookId)) out.push(v);
    });
    return out.sort((a, b) => b.startedAt - a.startedAt);
  }

  /** Adds or updates a session's entry (skipped when nothing changed). */
  putLecture(s: LectureSummary): void {
    const cur = this.lectureMap.get(s.id);
    if (cur && JSON.stringify(cur) === JSON.stringify(s)) return;
    this.doc.transact(() => this.lectureMap.set(s.id, { ...s }), LOCAL_ORIGIN);
  }

  removeLecture(id: string): void {
    if (this.lectureMap.has(id)) this.doc.transact(() => this.lectureMap.delete(id), LOCAL_ORIGIN);
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

  // ---- saved colours (tech-spec §2): one Y.Array per tool; never set = the brand palette ----

  /** The tool's saved colours in order (normalised, deduplicated, at most MAX_SWATCHES). */
  swatches(tool: SwatchTool): string[] {
    const a = this.swatchMap.get(tool);
    return dedupe(tool, a ? a.toArray() : DEFAULT_SWATCHES[tool]);
  }

  /** True once the user has changed this tool's swatches (added, moved or removed one). */
  hasCustomSwatches(tool: SwatchTool): boolean {
    return this.swatchMap.has(tool);
  }

  /** Replaces the tool's list (normalised, deduplicated, capped). */
  setSwatches(tool: SwatchTool, colors: readonly string[]): void {
    const list = dedupe(tool, colors);
    this.tx(() => {
      let a = this.swatchMap.get(tool);
      if (!a) {
        a = new Y.Array<string>();
        this.swatchMap.set(tool, a);
      } else if (a.length) a.delete(0, a.length);
      a.insert(0, list);
    });
  }

  /**
   * Appends a colour. Returns false (and changes nothing) if it isn't a colour, is already saved, or the list is full.
   * Edits rewrite the whole (tiny) array. Two devices editing at once leave both lists in it; reads deduplicate.
   */
  addSwatch(tool: SwatchTool, color: string): boolean {
    const c = swatchColor(tool, color);
    const cur = this.swatches(tool);
    if (!c || cur.includes(c) || cur.length >= MAX_SWATCHES) return false;
    this.setSwatches(tool, [...cur, c]);
    return true;
  }

  /** Moves a saved colour to `index` (clamped). */
  moveSwatch(tool: SwatchTool, color: string, index: number): void {
    const c = swatchColor(tool, color);
    const cur = this.swatches(tool);
    const from = c ? cur.indexOf(c) : -1;
    if (from < 0) return;
    cur.splice(from, 1);
    cur.splice(Math.max(0, Math.min(cur.length, Math.round(index))), 0, c!);
    this.setSwatches(tool, cur);
  }

  removeSwatch(tool: SwatchTool, color: string): void {
    const c = swatchColor(tool, color);
    const cur = this.swatches(tool);
    if (!c || !cur.includes(c)) return;
    this.setSwatches(tool, cur.filter((x) => x !== c));
  }

  /** Back to the brand palette (removes the custom list). */
  resetSwatches(tool: SwatchTool): void {
    this.tx(() => this.swatchMap.delete(tool));
  }

  /**
   * Brings `from`'s custom swatches into this library (signed-out colours on sign-in): the account's list first,
   * then the other's colours it lacks, capped. Lists `from` never changed are left alone.
   */
  mergeSwatchesFrom(from: Library): void {
    for (const tool of ['pen', 'highlighter'] as const) {
      if (!from.hasCustomSwatches(tool)) continue;
      const mine = this.hasCustomSwatches(tool) ? this.swatches(tool) : [];
      const merged = this.hasCustomSwatches(tool) ? [...mine, ...from.swatches(tool)] : from.swatches(tool);
      this.setSwatches(tool, merged);
    }
  }

  observe(cb: (tx: Y.Transaction) => void): () => void {
    const h = (tx: Y.Transaction) => {
      if (tx.changed.size > 0) cb(tx);
    };
    this.doc.on('afterTransaction', h);
    return () => this.doc.off('afterTransaction', h);
  }
}
