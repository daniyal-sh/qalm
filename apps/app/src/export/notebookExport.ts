import { exportPdf, LOCAL_ORIGIN, Notebook, packQalm, Page, unpackQalm, createNotebookDoc } from '@qalm/core';
import type { Asset, NotebookInit, NotebookMeta, Size } from '@qalm/core';
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

/** PDF with ink flattened (core `exportPdf`). */
export function buildPdf(src: NotebookSource): Promise<Uint8Array> {
  return withPages(src, (pages) =>
    exportPdf(
      src.notebook,
      async (pageId) => {
        const d = pages.get(pageId);
        return new Page(d ?? new Y.Doc());
      },
      assetGetter(src),
    ),
  );
}

/** Full-fidelity `.qalm` backup (core `packQalm`). Assets that can't be read are left out. */
export function buildQalm(src: NotebookSource): Promise<Uint8Array> {
  return withPages(src, async (pages) => {
    const assets = new Map<string, Uint8Array>();
    const get = assetGetter(src);
    for (const a of src.notebook.assets()) {
      try {
        assets.set(a.id, await get(a.id));
      } catch {
        /* not downloaded and offline: skip */
      }
    }
    return packQalm({ index: src.notebook.doc, pages, assets });
  });
}

export function exportFileName(title: string, ext: 'pdf' | 'qalm'): string {
  const base = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Notebook';
  return `${base}.${ext}`;
}

/** Restores a `.qalm` into local docs. Returns the notebook's meta (its id is kept, so restoring twice merges). */
export async function restoreQalm(
  bytes: Uint8Array,
  writeDoc: (docId: string, update: Uint8Array) => Promise<void>,
  putAsset: (asset: Asset, bytes: Uint8Array) => Promise<void>,
): Promise<NotebookMeta> {
  const b = unpackQalm(bytes);
  const nb = new Notebook(b.index);
  const meta = nb.meta();
  if (!meta.id) throw new Error('not a Qalm backup');
  await writeDoc(docIds.notebook(meta.id), Y.encodeStateAsUpdate(b.index));
  for (const [pageId, doc] of b.pages) await writeDoc(docIds.page(meta.id, pageId), Y.encodeStateAsUpdate(doc));
  for (const [id, data] of b.assets) {
    const a = nb.asset(id);
    if (a) await putAsset(a, data);
  }
  return meta;
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
