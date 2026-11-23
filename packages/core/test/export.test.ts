import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { PDFDocument, rgb } from 'pdf-lib';
import { Notebook, Page, exportPdf, packQalm, renderPageSvg, unpackQalm } from '../src';
import { newNotebook, stroke } from './helpers';

declare const atob: (s: string) => string;
const PNG_1PX = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);

async function sourcePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 2; i++) doc.addPage([612, 792]).drawRectangle({ x: 50, y: 50, width: 100, height: 100, color: rgb(1, 0, 0) });
  return doc.save();
}

function fill(page: Page) {
  page.addItem(stroke('s1', 50, 100, 150, 120));
  page.addItem(stroke('hl', 40, 100, 160, 120, { tool: 'highlighter', width: 12, color: '#fde68a' }));
  page.addItem({ id: 'sh', type: 'shape', kind: 'ellipse', pts: [[200, 200], [300, 260]], color: '#1d4ed8', width: 2 });
  page.addItem({ id: 'tx', type: 'text', x: 50, y: 300, w: 200, text: 'Area ∫ under the curve & more <words>', fontSize: 14, color: '#27272a' });
  page.addItem({ id: 'im', type: 'image', assetId: 'png1', x: 300, y: 300, w: 40, h: 40 });
  // Turned by the selection's rotate handle; a rotated ellipse is stored as its 4 box corners.
  page.addItem({ id: 'im2', type: 'image', assetId: 'png1', x: 400, y: 300, w: 40, h: 20, rot: Math.PI / 2 });
  page.addItem({ id: 'tx2', type: 'text', x: 400, y: 400, w: 100, text: 'turned', fontSize: 12, color: '#27272a', rot: -Math.PI / 6 });
  page.addItem({ id: 'el2', type: 'shape', kind: 'ellipse', pts: [[100, 500], [140, 540], [120, 560], [80, 520]], color: '#000', width: 2 });
}

describe('renderPageSvg', () => {
  it('draws paper and items in z-order', () => {
    const nb = newNotebook();
    const page = new Page(new Y.Doc());
    fill(page);
    const svg = renderPageSvg(nb.pages()[0]!, page, { assetUrl: (id) => `https://x/${id}` });
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 595 842"')).toBe(true);
    expect(svg).toContain('fill="#ffffff"');
    expect(svg).toContain('stroke="#d9dce3"');
    expect(svg).toContain('fill-opacity="0.45"');
    expect(svg).toContain('&amp;</tspan><tspan x="50" y="332.2">more &lt;words&gt;'); // escaped and wrapped
    expect(svg).toContain('href="https://x/png1"');
    expect(svg).toContain('transform="rotate(90 400 300)"');
    expect(svg).toContain('transform="rotate(-30 400 400)"');
    expect(svg.indexOf('fill="#27272a"')).toBeLessThan(svg.indexOf('fill="#fde68a"'));
    expect(renderPageSvg(nb.pages()[0]!, page, { paper: false })).not.toContain('#d9dce3');
  });
});

describe('exportPdf', () => {
  it('writes a PDF that pdf-lib loads, with the source PDF page as background', async () => {
    const nb = newNotebook();
    nb.addAsset({ id: 'pdf1', sha256: 'x', mime: 'application/pdf', name: 'hw.pdf', bytes: 1, pageCount: 2 });
    const pdfPage = nb.addPage({ size: { w: 612, h: 792 }, background: { kind: 'pdf', assetId: 'pdf1', pageIndex: 1 } });
    nb.addPage({ paper: 'dotted', paperColor: 'night' });
    const pages = new Map(nb.pages().map((p) => [p.id, new Page(new Y.Doc())]));
    fill(pages.get(nb.pages()[0]!.id)!);
    pages.get(pdfPage)!.addItem(stroke('p1', 60, 60, 200, 80));
    const assets: Record<string, Uint8Array> = { pdf1: await sourcePdf(), png1: PNG_1PX };
    const loads: string[] = [];
    const bytes = await exportPdf(
      nb,
      async (id) => pages.get(id)!,
      async (id) => {
        loads.push(id);
        return assets[id]!;
      },
    );
    const out = await PDFDocument.load(bytes);
    expect(out.getPageCount()).toBe(3);
    expect(out.getPage(0).getSize()).toEqual({ width: 595, height: 842 });
    expect(out.getPage(1).getSize()).toEqual({ width: 612, height: 792 });
    expect(loads.sort()).toEqual(['pdf1', 'png1']);
    expect(out.getTitle()).toBe('Calculus');
  });
});

describe('.qalm', () => {
  it('round-trips index, pages and assets', () => {
    const nb = newNotebook();
    const id2 = nb.addPage();
    const pages = new Map<string, Y.Doc>();
    for (const p of nb.pages()) {
      const page = new Page(new Y.Doc());
      page.addItem(stroke(`s-${p.id}`, 50, 100, 150, 120));
      page.setLineText(`s-${p.id}`, 'hi', 'user');
      pages.set(p.id, page.doc);
    }
    const bytes = packQalm({ index: nb.doc, pages, assets: new Map([['png1', PNG_1PX]]) });
    const back = unpackQalm(bytes);
    const nb2 = new Notebook(back.index);
    expect(nb2.meta()).toEqual(nb.meta());
    expect(nb2.pages()).toEqual(nb.pages());
    expect([...back.pages.keys()].sort()).toEqual([...pages.keys()].sort());
    const p2 = new Page(back.pages.get(id2)!);
    expect(p2.items()).toEqual(new Page(pages.get(id2)!).items());
    expect(p2.lines()).toMatchObject([{ key: `s-${id2}`, text: 'hi', textSrc: 'user' }]);
    expect(back.assets.get('png1')).toEqual(PNG_1PX);
    expect(() => unpackQalm(packQalm({ index: nb.doc, pages: new Map(), assets: new Map() }).slice(0, 10))).toThrow();
  });
});
