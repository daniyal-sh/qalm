import { exportPdf, LOCAL_ORIGIN, Notebook, packQalm, packQalmStream, Page, summarizeThreads, unpackQalm, createNotebookDoc } from '@qalm/core';
import type { Asset, ExportPdfOptions, LectureBundle, NotebookInit, NotebookMeta, Size } from '@qalm/core';
import { PDFDocument } from 'pdf-lib';
import * as Y from 'yjs';

import { docIds } from '../sync/docs';

/** What export needs from the app: the notebook, a way to load each page doc, and asset bytes. */
export interface NotebookSource {
  notebook: Notebook;
  loadPage(pageId: string): Promise<{ doc: Y.Doc; release(): void }>;
  assetBytes(asset: Asset): Promise<Uint8Array>;
}

async function withPages<T>(src: NotebookSource, fn: (pages: Map<string, Y.Doc>) => Promise<T>): Promise<T> {
  const loaded = new Map<string, { doc: Y.Doc; release(): void }>();
  try {
    for (const p of src.notebook.pages()) loaded.set(p.id, await src.loadPage(p.id));
    return await fn(new Map([...loaded].map(([id, h]) => [id, h.doc])));
  } finally {
    for (const h of loaded.values()) h.release();
  }
}

function assetGetter(src: NotebookSource) {
  return async (id: string): Promise<Uint8Array> => {
    const a = src.notebook.asset(id);
    if (!a) throw new Error(`missing asset ${id}`);
    return src.assetBytes(a);
  };
}

/** PDF with ink flattened (core `exportPdf`). `opts`: converting images PDF can't hold, and hearing which still failed. */
export function buildPdf(src: NotebookSource, opts?: ExportPdfOptions): Promise<Uint8Array> {
  return withPages(src, (pages) =>
    exportPdf(
      src.notebook,
      async (pageId) => {
        const d = pages.get(pageId);
        return new Page(d ?? new Y.Doc());
      },
      assetGetter(src),
      opts,
    ),
  );
}

/**
 * Full-fidelity `.qalm` backup (core `packQalm`). Assets that can't be read are left out. `lectures`: the lecture
 * export (docs/lecture-mode.md §8); without it the file is the plain backup.
 */
export function buildQalm(src: NotebookSource, lectures?: LectureBundle[]): Promise<Uint8Array> {
  return withPages(src, async (pages) => {
    const assets = await readAssets(src);
    return packQalm({ index: src.notebook.doc, pages, assets, ...(lectures?.length ? { lectures } : {}) });
  });
}

async function readAssets(src: NotebookSource): Promise<Map<string, Uint8Array>> {
  const assets = new Map<string, Uint8Array>();
  const get = assetGetter(src);
  for (const a of src.notebook.assets()) {
    try {
      assets.set(a.id, await get(a.id));
    } catch {
      /* not downloaded and offline: skip */
    }
  }
  return assets;
}

/**
 * The lecture export (docs/lecture-mode.md §8) as a streamed zip (core `packQalmStream`): sessions are read one at a
 * time and the file goes out in parts through `out`, so hours of audio are never held twice.
 */
export function buildQalmStream(src: NotebookSource, sessions: AsyncIterable<LectureBundle>, out: (part: Uint8Array) => void | Promise<void>): Promise<void> {
  return withPages(src, async (pages) => packQalmStream({ index: src.notebook.doc, pages, assets: await readAssets(src) }, sessions, out));
}

export function exportFileName(title: string, ext: 'pdf' | 'qalm'): string {
  const base = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Notebook';
  return `${base}.${ext}`;
}

/**
 * Restores a `.qalm` backup as a NEW notebook: fresh notebook and page ids, title suffixed " (restored)". Items, readings,
 * comments, pages, assets and meta are copied; the original notebook (if it still exists) is never touched.
 * Returns the new notebook's meta.
 */
export async function restoreQalm(
  bytes: Uint8Array,
  writeDoc: (docId: string, update: Uint8Array) => Promise<void>,
  putAsset: (asset: Asset, bytes: Uint8Array) => Promise<void>,
  newId: () => string,
  /** Lecture sessions in the file (a lecture export): restore them, or leave this out to skip them safely. */
  restoreLectures?: (sessions: LectureBundle[], pageIds: Map<string, string>, notebookId: string) => Promise<void>,
): Promise<NotebookMeta> {
  const b = unpackQalm(bytes);
  const src = new Notebook(b.index);
  const old = src.meta();
  if (!old.id) throw new Error('not a qalm backup');
  const id = newId();
  const pageIds = new Map(src.pages().map((p) => [p.id, newId()]));

  const index = new Y.Doc();
  const nb = new Notebook(index);
  index.transact(() => {
    // AI access starts off: a restored copy is a new notebook, and sharing it with agents is the user's choice.
    const meta: NotebookMeta = { ...old, id, title: `${old.title || 'Notebook'} (restored)`, aiAccess: false, updatedAt: Date.now() };
    const m = index.getMap('meta');
    for (const [k, v] of Object.entries(meta)) if (v !== undefined) m.set(k, v);
    for (const p of src.pages()) nb.addPage({ ...p, id: pageIds.get(p.id)! });
    for (const a of src.assets()) nb.addAsset(a);
  }, LOCAL_ORIGIN);

  // Assets first, so pages never reference bytes this device lacks.
  for (const [aid, data] of b.assets) {
    const a = src.asset(aid);
    if (a) await putAsset(a, data);
  }
  for (const [oldPage, newPage] of pageIds) {
    const doc = b.pages.get(oldPage);
    if (doc) await writeDoc(docIds.page(id, newPage), Y.encodeStateAsUpdate(doc));
  }
  // The thread index, rebuilt from the restored pages (the backup's own may be missing or stale).
  for (const [oldPage, newPage] of pageIds) {
    const doc = b.pages.get(oldPage);
    if (!doc) continue;
    const page = new Page(doc);
    nb.putThreads(summarizeThreads(newPage, page.comments(), page.readings()));
  }
  index.transact(() => index.getMap('meta').set('threadsIndexed', true), LOCAL_ORIGIN);
  await writeDoc(docIds.notebook(id), Y.encodeStateAsUpdate(index));
  if (b.lectures?.length && restoreLectures) await restoreLectures(b.lectures, pageIds, id);
  return nb.meta();
}

/** Page sizes (PDF points) of a PDF, read with pdf-lib. */
export async function pdfPageSizes(bytes: Uint8Array): Promise<Size[]> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  return doc.getPages().map((p) => {
    const { width, height } = p.getSize();
    const rot = ((p.getRotation().angle % 360) + 360) % 360;
    return rot === 90 || rot === 270 ? { w: height, h: width } : { w: width, h: height };
  });
}

/** An index doc for an imported PDF: one page per PDF page, each with the PDF page as background. */
export function buildPdfNotebook(init: NotebookInit, asset: Asset, sizes: Size[]): Y.Doc {
  const first = sizes[0] ?? init.size;
  const doc = createNotebookDoc({ ...init, size: first });
  const nb = new Notebook(doc);
  doc.transact(() => {
    const placeholder = nb.pages().map((p) => p.id);
    nb.addAsset({ ...asset, pageCount: sizes.length });
    sizes.forEach((size, i) =>
      nb.addPage({ size, paper: 'blank', paperColor: 'white', background: { kind: 'pdf', assetId: asset.id, pageIndex: i } }),
    );
    for (const id of placeholder) nb.removePage(id);
  }, LOCAL_ORIGIN);
  return doc;
}
