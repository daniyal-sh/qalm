import { createNotebookDoc, Notebook, Page } from '@qalm/core';
import type { Asset } from '@qalm/core';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { cloneItems, IDENTITY, itemBBox, transformItem } from '../src/editor/items';
import {
  buildPdf,
  buildPdfNotebook,
  buildQalm,
  exportFileName,
  pdfPageSizes,
  restoreQalm,
  type NotebookSource,
} from '../src/export/notebookExport';
import { docIds } from '../src/sync/docs';
import { stroke } from './helpers';

function source() {
  const nb = new Notebook(createNotebookDoc({ id: 'nb1', title: 'Calc', cover: '#4338ca', paper: 'ruled', paperColor: 'white', size: { w: 595, h: 842 } }));
  const pages = new Map<string, Y.Doc>();
  const first = nb.pages()[0]!.id;
  const p = new Page(new Y.Doc());
  p.addItem(stroke(40, 100, 200, 100));
  p.addItem({ id: 't1', type: 'text', x: 40, y: 200, w: 200, text: 'Hello', fontSize: 16, color: '#27272a' });
  pages.set(first, p.doc);
  let released = 0;
  const src: NotebookSource = {
    notebook: nb,
    loadPage: async (id) => ({ doc: pages.get(id) ?? new Y.Doc(), release: () => void released++ }),
    assetBytes: async () => new Uint8Array(),
  };
  return { nb, src, first, released: () => released };
}

describe('export wiring', () => {
  it('builds a PDF with one page per notebook page and releases page docs', async () => {
    const { src, nb, released } = source();
    nb.addPage();
    const bytes = await buildPdf(src);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(2);
    expect(released()).toBe(2);
  });

  it('restores a .qalm backup as a new notebook with new ids, leaving the original untouched', async () => {
    const { src, first, nb } = source();
    const second = nb.addPage({ paper: 'grid' });
    const asset: Asset = { id: 'a1', sha256: 'e'.repeat(64), mime: 'image/png', name: 'fig.png', bytes: 3 };
    nb.addAsset(asset);
    const page1 = await src.loadPage(first);
    const p1 = new Page(page1.doc);
    const lineKey = p1.lines()[0]!.key;
    p1.setLineText(lineKey, 'x^2', 'user');
    p1.addComment({ lineKey, author: { kind: 'agent', name: 'Tutor' }, text: 'Nice' });
    src.assetBytes = async () => new Uint8Array([1, 2, 3]);
    const before = { index: Y.encodeStateAsUpdate(nb.doc), page: Y.encodeStateAsUpdate(page1.doc) };

    const bytes = await buildQalm(src);
    const written = new Map<string, Uint8Array>();
    const assets: string[] = [];
    let n = 0;
    const meta = await restoreQalm(bytes, async (id, u) => void written.set(id, u), async (a) => void assets.push(a.id), () => `new${++n}`);

    expect(meta.id).not.toBe('nb1');
    expect(meta.title).toBe('Calc (restored)');
    const index = new Notebook(new Y.Doc());
    Y.applyUpdate(index.doc, written.get(docIds.notebook(meta.id))!);
    expect(index.meta()).toMatchObject({ id: meta.id, title: 'Calc (restored)', cover: '#4338ca', paper: 'ruled' });
    const pages = index.pages();
    expect(pages).toHaveLength(2);
    expect(pages.map((p) => p.id)).not.toContain(first);
    expect(pages.map((p) => p.id)).not.toContain(second);
    expect(pages[1]!.paper).toBe('grid');
    expect(index.asset('a1')).toEqual(asset);
    expect(assets).toEqual(['a1']);
    // Only the new ids were written: nothing under the original notebook.
    expect([...written.keys()].every((k) => !k.includes('nb1'))).toBe(true);

    const page = new Page(new Y.Doc());
    Y.applyUpdate(page.doc, written.get(docIds.page(meta.id, pages[0]!.id))!);
    expect(page.items().map((i) => i.type)).toEqual(['stroke', 'text']);
    expect(page.lines().find((l) => l.key === lineKey)).toMatchObject({ text: 'x^2', textSrc: 'user' });
    expect(page.comments().map((c) => c.text)).toEqual(['Nice']);

    // The original docs are unchanged.
    expect(Y.encodeStateAsUpdate(nb.doc)).toEqual(before.index);
    expect(Y.encodeStateAsUpdate(page1.doc)).toEqual(before.page);
  });

  it('makes safe file names', () => {
    expect(exportFileName('Q3: plan / notes?', 'pdf')).toBe('Q3 plan notes.pdf');
    expect(exportFileName('   ', 'qalm')).toBe('Notebook.qalm');
  });
});

describe('PDF import', () => {
  it('creates one page per PDF page with the PDF as background', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([612, 792]);
    pdf.addPage([842, 595]);
    const sizes = await pdfPageSizes(await pdf.save());
    expect(sizes).toEqual([{ w: 612, h: 792 }, { w: 842, h: 595 }]);
    const asset: Asset = { id: 'a1', sha256: 'f'.repeat(64), mime: 'application/pdf', name: 'ps4.pdf', bytes: 10 };
    const nb = new Notebook(buildPdfNotebook({ id: 'n', title: 'ps4', cover: '#0f766e', paper: 'blank', paperColor: 'white', size: { w: 595, h: 842 } }, asset, sizes));
    const pages = nb.pages();
    expect(pages).toHaveLength(2);
    expect(pages[1]!.size).toEqual({ w: 842, h: 595 });
    expect(pages.map((p) => p.background)).toEqual([
      { kind: 'pdf', assetId: 'a1', pageIndex: 0 },
      { kind: 'pdf', assetId: 'a1', pageIndex: 1 },
    ]);
    expect(nb.asset('a1')?.pageCount).toBe(2);
  });
});

describe('selection transforms', () => {
  it('moves and scales items about an origin', () => {
    const s = stroke(10, 10, 30, 10);
    const t = transformItem(s, { dx: 5, dy: 0, s: 2, ox: 10, oy: 10 });
    expect(t.type === 'stroke' && t.points[t.points.length - 1]!.x).toBe(55);
    expect(t.type === 'stroke' && t.width).toBeCloseTo(3.6);
    const img = transformItem({ id: 'i', type: 'image', assetId: 'a', x: 0, y: 0, w: 10, h: 20 }, { dx: 1, dy: 2, s: 0.5, ox: 0, oy: 0 });
    expect(itemBBox(img)).toEqual([1, 2, 6, 12]);
    expect(transformItem(s, IDENTITY)).toEqual(s);
  });

  it('clones with fresh ids', () => {
    const s = stroke(0, 0, 10, 0);
    const [c] = cloneItems([s], 16, 16, () => 'new');
    expect(c!.id).toBe('new');
    expect(itemBBox(c!)[0]).toBeCloseTo(itemBBox(s)[0] + 16);
  });
});
