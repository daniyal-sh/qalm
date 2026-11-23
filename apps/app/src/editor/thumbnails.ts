/**
 * Page thumbnails for the navigator: rendered lazily (only for cells on screen), one at a time, small (a JPEG data
 * uri), and cached per page until the page changes. A page's doc is opened only to render it and released right
 * after, so the navigator never loads every page at once.
 */
import { Page, type PageInfo } from '@qalm/core';

import { docIds, openLoaded, type DocManager } from '../sync/docs';
import { RenderQueue } from './renderQueue';

export interface ThumbnailDeps {
  dm: DocManager;
  notebookId: string;
  /** The PDF file uri for a background asset (null if unavailable). */
  pdfUri(assetId: string): Promise<string | null>;
  /** Renders a PDF page background at `widthPx` (QalmInk.renderPdfPage). */
  renderPdf(fileUri: string, pageIndex: number, widthPx: number): Promise<string>;
  /** Draws the thumbnail (qalm-ink's renderThumbnail). */
  draw(input: { info: PageInfo; items: ReturnType<Page['items']>; background?: string; width: number }): Promise<string>;
  /** Thumbnails kept in memory (LRU). */
  max?: number;
}

interface Entry {
  uri: string;
  /** The page changed since this was drawn. */
  stale: boolean;
}

export class Thumbnails {
  private cache = new Map<string, Entry>();
  private subs = new Map<string, Set<() => void>>();
  private queue = new RenderQueue(1);
  private off: () => void;

  constructor(private readonly deps: ThumbnailDeps) {
    const prefix = `pg:${deps.notebookId}:`;
    this.off = deps.dm.onUpdate((docId) => {
      if (!docId.startsWith(prefix)) return;
      const pageId = docId.slice(prefix.length);
      const e = this.cache.get(pageId);
      if (e && !e.stale) {
        e.stale = true;
        this.emit(pageId);
      }
    });
  }

  get(pageId: string): Entry | undefined {
    return this.cache.get(pageId);
  }

  subscribe(pageId: string, cb: () => void): () => void {
    let s = this.subs.get(pageId);
    if (!s) this.subs.set(pageId, (s = new Set()));
    s.add(cb);
    return () => {
      s!.delete(cb);
      if (!s!.size) this.subs.delete(pageId);
    };
  }

  /** Drops a page's thumbnail (e.g. its settings changed). */
  invalidate(pageId: string): void {
    const e = this.cache.get(pageId);
    if (e) {
      e.stale = true;
      this.emit(pageId);
    }
  }

  /**
   * Renders the page's thumbnail if it has none or a stale one. Queued (one at a time; lowest `priority` first);
   * `cancel()` drops the request if it hasn't started, e.g. the cell scrolled away.
   */
  request(info: PageInfo, width: number, priority = 0): () => void {
    const e = this.cache.get(info.id);
    if (e && !e.stale) return () => undefined;
    const job = this.queue.request(() => this.render(info, width), priority);
    job.promise.catch(() => undefined);
    return job.cancel;
  }

  dispose(): void {
    this.off();
    this.cache.clear();
    this.subs.clear();
  }

  private emit(pageId: string): void {
    for (const cb of [...(this.subs.get(pageId) ?? [])]) cb();
  }

  private async render(info: PageInfo, width: number): Promise<void> {
    const { dm, notebookId } = this.deps;
    const h = await openLoaded(dm, docIds.page(notebookId, info.id));
    try {
      const items = new Page(h.doc).items();
      let background: string | undefined;
      if (info.background.kind === 'pdf') {
        const file = await this.deps.pdfUri(info.background.assetId);
        if (file) background = await this.deps.renderPdf(file, info.background.pageIndex, width).catch(() => undefined);
      }
      const uri = await this.deps.draw({ info, items, background, width });
      this.cache.delete(info.id);
      this.cache.set(info.id, { uri, stale: false });
      const max = this.deps.max ?? 400;
      while (this.cache.size > max) this.cache.delete(this.cache.keys().next().value as string);
      this.emit(info.id);
    } finally {
      h.release();
    }
  }
}
