/** Library operations that touch docs, assets and files (wrapping the pure helpers in actions.ts and export/). */
import { Notebook, type Library, type NotebookMeta } from '@qalm/core';
import { Alert, Platform } from 'react-native';
import * as Y from 'yjs';

import type { AssetService } from '../assets/assetService';
import { buildPdf, buildPdfNotebook, buildQalm, exportFileName, pdfPageSizes, restoreQalm, type NotebookSource } from '../export/notebookExport';
import { saveFile } from '../export/save';
import { toPng } from '../export/toPng';
import { newId } from '../lib/id';
import { stripExt, type PickedFile } from '../lib/mime';
import { docIds, openLoaded, type DocManager } from '../sync/docs';
import { removeLocalDoc } from '../sync/persistence';
import { buildNotebook, copyInto, entryFor, type NewNotebookForm } from './actions';

export interface Ctx {
  dm: DocManager;
  assets: AssetService;
  library: Library;
  /** Signed-in API access (Bearer); null when offline-only or signed out. */
  server?: { fetch(path: string, init?: RequestInit): Promise<Response> } | null;
}

async function writeDoc(dm: DocManager, docId: string, source: Y.Doc | Uint8Array): Promise<void> {
  const h = await openLoaded(dm, docId);
  try {
    if (source instanceof Uint8Array) Y.applyUpdate(h.doc, source);
    else copyInto(h.doc, source);
  } finally {
    h.release();
  }
}

export async function createNotebook(ctx: Ctx, form: NewNotebookForm, folderId: string | null): Promise<string> {
  const id = newId();
  const doc = buildNotebook(id, form);
  await writeDoc(ctx.dm, docIds.notebook(id), doc);
  ctx.library.putEntry(entryFor(new Notebook(doc).meta(), folderId));
  return id;
}

export async function importPdf(ctx: Ctx, file: PickedFile, folderId: string | null, cover: string): Promise<string> {
  const sizes = await pdfPageSizes(file.bytes);
  if (!sizes.length) throw new Error('This PDF has no pages');
  const asset = await ctx.assets.put(file.bytes, 'application/pdf', file.name, { pageCount: sizes.length });
  const id = newId();
  const title = stripExt(file.name) || 'Imported PDF';
  const doc = buildPdfNotebook({ id, title, cover, paper: 'blank', paperColor: 'white', size: sizes[0]! }, asset, sizes);
  await writeDoc(ctx.dm, docIds.notebook(id), doc);
  ctx.library.putEntry(entryFor(new Notebook(doc).meta(), folderId));
  return id;
}

/** Restores a `.qalm` backup as a new notebook (new ids), so it never collides with the original. */
export async function importQalm(ctx: Ctx, file: PickedFile, folderId: string | null): Promise<string> {
  // Checked once for the whole backup (its size stands in for its PDFs and images), so a restore never stops halfway.
  await ctx.assets.ensureRoom(file.bytes.length);
  const meta: NotebookMeta = await restoreQalm(
    file.bytes,
    (docId, update) => writeDoc(ctx.dm, docId, update),
    async (asset, bytes) => {
      await ctx.assets.putUnchecked(bytes, asset.mime, asset.name);
    },
    newId,
  );
  ctx.library.putEntry(entryFor(meta, folderId));
  return meta.id;
}

/** Applies a meta patch to the index doc and mirrors title/cover/aiAccess into the library entry. */
export async function updateNotebookMeta(ctx: Ctx, id: string, patch: Partial<Pick<NotebookMeta, 'title' | 'cover' | 'aiAccess'>>): Promise<void> {
  const h = await openLoaded(ctx.dm, docIds.notebook(id));
  try {
    new Notebook(h.doc).setMeta(patch);
  } finally {
    h.release();
  }
  ctx.library.updateEntry(id, { ...patch, updatedAt: Date.now() });
}

/**
 * Permanently deletes a notebook: on the server first when signed in (DELETE /notebooks/{id} tombstones it and purges
 * its docs; 404 means it was never synced), then from this device and the library.
 */
export async function deleteForever(ctx: Ctx, id: string): Promise<void> {
  if (ctx.server) {
    let res: Response;
    try {
      res = await ctx.server.fetch(`/notebooks/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch {
      throw new Error('Couldn’t reach the server. Try again when you’re online.');
    }
    if (!res.ok && res.status !== 404) throw new Error(`Couldn’t delete on the server (${res.status})`);
  }
  const nbId = docIds.notebook(id);
  const h = await openLoaded(ctx.dm, nbId);
  const pageIds = new Notebook(h.doc).pages().map((p) => p.id);
  h.release();
  for (const pid of pageIds) {
    const d = docIds.page(id, pid);
    await ctx.dm.drop(d);
    await removeLocalDoc(d).catch(() => undefined);
  }
  await ctx.dm.drop(nbId);
  await removeLocalDoc(nbId).catch(() => undefined);
  ctx.library.removeEntry(id);
}

export function notebookSource(ctx: Pick<Ctx, 'dm' | 'assets'>, notebook: Notebook): NotebookSource {
  const nbId = notebook.meta().id;
  return {
    notebook,
    loadPage: async (pageId) => {
      const h = await openLoaded(ctx.dm, docIds.page(nbId, pageId), 3000);
      return { doc: h.doc, release: () => h.release() };
    },
    assetBytes: (a) => ctx.assets.bytes(a),
  };
}

/** A plain message: the browser dialog on web, an Alert on native. */
function notice(title: string, body: string): void {
  if (Platform.OS === 'web') (globalThis as { alert?: (m: string) => void }).alert?.(`${title}\n\n${body}`);
  else Alert.alert(title, body);
}

/** A question with Retry and OK: the browser's confirm on web, an Alert on native. Resolves true for Retry. */
function askRetry(title: string, body: string): Promise<boolean> {
  if (Platform.OS === 'web') return Promise.resolve(!!(globalThis as { confirm?: (m: string) => boolean }).confirm?.(`${title}\n\n${body}\n\nRetry?`));
  return new Promise((resolve) =>
    Alert.alert(title, body, [
      { text: 'OK', style: 'cancel', onPress: () => resolve(false) },
      { text: 'Retry', onPress: () => resolve(true) },
    ]),
  );
}

/** What to say when maths couldn't load for a PDF export (it went in as TeX source). */
export const MATHS_FALLBACK_NOTICE = {
  title: 'Maths couldn’t load',
  body: 'The PDF was exported with its maths as plain TeX. Check your connection and export again to get the formulas.',
} as const;

export async function exportNotebook(ctx: Pick<Ctx, 'dm' | 'assets'>, id: string, kind: 'pdf' | 'qalm'): Promise<void> {
  const h = await openLoaded(ctx.dm, docIds.notebook(id), 3000);
  let released = false;
  try {
    const nb = new Notebook(h.doc);
    const src = notebookSource(ctx, nb);
    const skipped: string[] = [];
    let mathsAsTex = false;
    const bytes =
      kind === 'pdf'
        ? await buildPdf(src, { toPng, onSkippedImage: (id) => skipped.push(id), onMathUnavailable: () => (mathsAsTex = true) })
        : await buildQalm(src);
    await saveFile(exportFileName(nb.meta().title, kind), kind === 'pdf' ? 'application/pdf' : 'application/x-qalm', bytes);
    if (skipped.length) {
      const names = skipped.map((id) => nb.asset(id)?.name ?? 'image');
      const n = skipped.length;
      notice(
        n === 1 ? 'An image was left out of the PDF' : `${n} images were left out of the PDF`,
        `${names.join(', ')}: this device can’t convert ${n === 1 ? 'its format' : 'their format'} for PDF. The .qalm backup keeps ${n === 1 ? 'it' : 'them'}.`,
      );
    }
    if (mathsAsTex && (await askRetry(MATHS_FALLBACK_NOTICE.title, MATHS_FALLBACK_NOTICE.body))) {
      h.release();
      released = true;
      await exportNotebook(ctx, id, kind);
    }
  } finally {
    if (!released) h.release();
  }
}
