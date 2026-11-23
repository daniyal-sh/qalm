import * as Y from 'yjs';
import { LOCAL_ORIGIN } from '../origin';
import { newId } from '../ids';
import type { Ask, Asset, NotebookMeta, PageInfo, Paper, PaperColor, Size } from '../types';
import { threadNewer, THREADS_ORIGIN, type ThreadSummary } from './threads';

export interface NotebookInit { id: string; title: string; cover: string; paper: Paper; paperColor: PaperColor; size: Size }

function pageMap(p: PageInfo): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(p)) if (v !== undefined) m.set(k, v);
  return m;
}

function readPage(m: Y.Map<unknown>): PageInfo {
  const p: PageInfo = {
    id: m.get('id') as string,
    size: m.get('size') as Size,
    paper: m.get('paper') as Paper,
    paperColor: m.get('paperColor') as PaperColor,
    background: (m.get('background') as PageInfo['background']) ?? { kind: 'paper' },
  };
  if (m.get('bookmarked') === true) p.bookmarked = true;
  return p;
}

/** Creates an index doc with one first page. */
export function createNotebookDoc(init: NotebookInit): Y.Doc {
  const doc = new Y.Doc();
  const nb = new Notebook(doc);
  doc.transact(() => {
    const now = Date.now();
    const meta: NotebookMeta = {
      ...init,
      orientation: init.size.w > init.size.h ? 'landscape' : 'portrait',
      aiAccess: false,
      threadsIndexed: true, // a new notebook has no threads to index
      createdAt: now,
      updatedAt: now,
    };
    const m = doc.getMap('meta');
    for (const [k, v] of Object.entries(meta)) m.set(k, v);
    nb.addPage();
  }, LOCAL_ORIGIN);
  return doc;
}

/** Wraps a notebook's index doc. */
export class Notebook {
  readonly doc: Y.Doc;
  private readonly metaMap: Y.Map<unknown>;
  private readonly pageArr: Y.Array<Y.Map<unknown>>;
  private readonly assetMap: Y.Map<Asset>;
  private readonly askArr: Y.Array<Ask>;
  private readonly threadMap: Y.Map<ThreadSummary>;

  constructor(doc: Y.Doc) {
    this.doc = doc;
    this.metaMap = doc.getMap('meta');
    this.pageArr = doc.getArray('pages');
    this.assetMap = doc.getMap('assets');
    this.askArr = doc.getArray('asks');
    this.threadMap = doc.getMap('threads');
  }

  // ---- thread index (a summary of every comment thread; the page docs hold the threads themselves) ----

  /** Every indexed thread, including ones on pages since deleted (callers filter by the page list). */
  threads(): ThreadSummary[] {
    return [...this.threadMap.values()];
  }

  /**
   * Writes the summaries of one page's threads (read from its doc) where they are newer than the index: a thread only
   * gains entries and, between entries, only goes from open to resolved (a reply reopens it), so a writer holding an
   * older copy of the page can never roll an entry back. Threads are never removed (comments can't be deleted; threads
   * on deleted pages are filtered out by the page list). Returns whether anything was written.
   */
  putThreads(summaries: readonly ThreadSummary[]): boolean {
    const set: ThreadSummary[] = [];
    for (const t of summaries) {
      const cur = this.threadMap.get(t.id);
      const next = threadNewer(cur, t);
      if (next) set.push(next);
    }
    if (!set.length) return false;
    this.doc.transact(() => {
      for (const t of set) this.threadMap.set(t.id, t);
    }, THREADS_ORIGIN);
    return true;
  }

  /** Has every page's threads been indexed once (`markThreadsIndexed`)? Older notebooks start without the index. */
  threadsIndexed(): boolean {
    return this.metaMap.get('threadsIndexed') === true;
  }

  markThreadsIndexed(): void {
    if (this.threadsIndexed()) return;
    this.doc.transact(() => this.metaMap.set('threadsIndexed', true), THREADS_ORIGIN);
  }

  private tx(fn: () => void): void {
    this.doc.transact(fn, LOCAL_ORIGIN);
  }

  meta(): NotebookMeta {
    return this.metaMap.toJSON() as NotebookMeta;
  }

  setMeta(patch: Partial<Omit<NotebookMeta, 'id' | 'createdAt'>>): void {
    this.tx(() => {
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) this.metaMap.set(k, v);
      if (patch.updatedAt === undefined) this.metaMap.set('updatedAt', Date.now());
    });
  }

  /** Pages in order (duplicates from concurrent moves are dropped). */
  pages(): PageInfo[] {
    const seen = new Set<string>();
    const out: PageInfo[] = [];
    for (const m of this.pageArr.toArray()) {
      const p = readPage(m);
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      out.push(p);
    }
    return out;
  }

  /** Adds a page (defaults from meta) at `index` (default: the end). Returns its id. */
  addPage(opts: Partial<PageInfo> = {}, index?: number): string {
    const meta = this.meta();
    const p: PageInfo = {
      id: opts.id ?? newId(),
      size: opts.size ?? meta.size,
      paper: opts.paper ?? meta.paper,
      paperColor: opts.paperColor ?? meta.paperColor,
      background: opts.background ?? { kind: 'paper' },
    };
    this.tx(() => {
      const at = index === undefined ? this.pageArr.length : Math.max(0, Math.min(index, this.pageArr.length));
      this.pageArr.insert(at, [pageMap(p)]);
    });
    return p.id;
  }

  private indexOf(id: string): number {
    return this.pageArr.toArray().findIndex((m) => m.get('id') === id);
  }

  removePage(id: string): void {
    this.tx(() => {
      for (let i = this.pageArr.length - 1; i >= 0; i--) if (this.pageArr.get(i).get('id') === id) this.pageArr.delete(i, 1);
    });
  }

  /** Bookmarks (or un-bookmarks) a page. */
  setBookmark(id: string, on: boolean): void {
    this.tx(() => {
      for (const m of this.pageArr.toArray()) {
        if (m.get('id') !== id) continue;
        if (on) m.set('bookmarked', true);
        else m.delete('bookmarked');
      }
    });
  }

  /**
   * Adds a copy of page `id`'s settings (size, paper, background) right after it, with a new id (not bookmarked).
   * The page's content lives in its own doc: copy it with `Page.copyFrom`. Returns the new id, or null.
   */
  duplicatePage(id: string, newPageId: string = newId()): string | null {
    const i = this.indexOf(id);
    if (i < 0) return null;
    const { bookmarked: _b, ...p } = readPage(this.pageArr.get(i));
    this.tx(() => this.pageArr.insert(i + 1, [pageMap({ ...p, id: newPageId })]));
    return newPageId;
  }

  /**
   * Changes the paper (pattern and/or colour) of pages `ids`, in one transaction (one undo step). PDF pages keep their
   * PDF: they are skipped. Returns how many pages changed.
   */
  setPagePaper(ids: readonly string[], patch: { paper?: Paper; paperColor?: PaperColor }): number {
    const want = new Set(ids);
    let n = 0;
    this.tx(() => {
      for (const m of this.pageArr.toArray()) {
        if (!want.has(m.get('id') as string) || readPage(m).background.kind !== 'paper') continue;
        let hit = false;
        for (const k of ['paper', 'paperColor'] as const) {
          const v = patch[k];
          if (v === undefined || m.get(k) === v) continue;
          m.set(k, v);
          hit = true;
        }
        if (hit) n++;
      }
    });
    return n;
  }

  /** Moves a page so it ends up at `index`. */
  movePage(id: string, index: number): void {
    this.tx(() => {
      const i = this.indexOf(id);
      if (i < 0) return;
      const p = readPage(this.pageArr.get(i));
      this.pageArr.delete(i, 1);
      this.pageArr.insert(Math.max(0, Math.min(index, this.pageArr.length)), [pageMap(p)]);
    });
  }

  assets(): Asset[] {
    return [...this.assetMap.values()];
  }

  asset(id: string): Asset | undefined {
    return this.assetMap.get(id);
  }

  addAsset(a: Asset): void {
    this.tx(() => this.assetMap.set(a.id, a));
  }

  /** Adds an Ask (optionally about a selection, answered in thread `commentId`). Returns its id. */
  addAsk(pageId: string, text: string, extra: Pick<Ask, 'sel' | 'commentId'> = {}): string {
    const ask: Ask = { id: newId(), pageId, text, at: Date.now() };
    if (extra.sel) ask.sel = { itemIds: [...extra.sel.itemIds], bbox: [...extra.sel.bbox] };
    if (extra.commentId) ask.commentId = extra.commentId;
    this.tx(() => this.askArr.push([ask]));
    return ask.id;
  }

  asks(): Ask[] {
    return this.askArr.toArray();
  }

  /** Called after every transaction that changed the index doc (local or remote). */
  observe(cb: (tx: Y.Transaction) => void): () => void {
    const h = (tx: Y.Transaction) => {
      if (tx.changed.size > 0) cb(tx);
    };
    this.doc.on('afterTransaction', h);
    return () => this.doc.off('afterTransaction', h);
  }
}
