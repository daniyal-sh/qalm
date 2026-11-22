import * as Y from 'yjs';
import { LOCAL_ORIGIN } from '../origin';
import { newId } from '../ids';
import type { Ask, Asset, NotebookMeta, PageInfo, Paper, PaperColor, Size } from '../types';

export interface NotebookInit { id: string; title: string; cover: string; paper: Paper; paperColor: PaperColor; size: Size }

function pageMap(p: PageInfo): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(p)) m.set(k, v);
  return m;
}

function readPage(m: Y.Map<unknown>): PageInfo {
  return {
    id: m.get('id') as string,
    size: m.get('size') as Size,
    paper: m.get('paper') as Paper,
    paperColor: m.get('paperColor') as PaperColor,
    background: (m.get('background') as PageInfo['background']) ?? { kind: 'paper' },
  };
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

  constructor(doc: Y.Doc) {
    this.doc = doc;
    this.metaMap = doc.getMap('meta');
    this.pageArr = doc.getArray('pages');
    this.assetMap = doc.getMap('assets');
    this.askArr = doc.getArray('asks');
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

  addAsk(pageId: string, text: string): void {
    this.tx(() => this.askArr.push([{ id: newId(), pageId, text, at: Date.now() }]));
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
