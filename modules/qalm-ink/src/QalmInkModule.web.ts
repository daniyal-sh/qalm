import { NativeModule, registerWebModule } from 'expo';

import type { QalmInkModuleType } from './QalmInk.types';

type PdfJs = typeof import('pdfjs-dist');
type PdfDoc = Awaited<ReturnType<PdfJs['getDocument']>['promise']>;

let pdfjsPromise: Promise<PdfJs> | null = null;
const docs = new Map<string, Promise<PdfDoc>>();
/** Rendered pages (object URLs), least recently used first. Older ones are revoked: each is a full-page PNG. */
const pages = new Map<string, Promise<string>>();
const MAX_PAGES = 24;

function remember(key: string, png: Promise<string>): void {
  pages.delete(key);
  pages.set(key, png);
  while (pages.size > MAX_PAGES) {
    const [oldest, url] = pages.entries().next().value as [string, Promise<string>];
    pages.delete(oldest);
    url.then((u) => URL.revokeObjectURL(u)).catch(() => undefined);
  }
}

/**
 * pdf.js needs its worker as a separate file. The app must serve
 * `pdfjs-dist/build/pdf.worker.min.mjs` next to its web build (e.g. copy it into `public/`).
 * Set `GlobalWorkerOptions.workerSrc` yourself before the first call to use another location.
 */
/**
 * The directory index.html is served from: an exported build's bundle URLs contain `/_expo/static/`. Otherwise (the
 * dev server, whose bundle is `/apps/app/index.ts.bundle`) the site root, where `public/` is served. Never the page
 * URL: on a deep route like `/notebook/<id>` it would point at `/notebook/pdf.worker.min.mjs`, which the SPA answers
 * with index.html, so the worker fails to load and every PDF page renders blank.
 */
function appBase(): string {
  const src = Array.from(document.scripts).find((s) => s.src.includes('/_expo/static/'))?.src;
  return src ? src.slice(0, src.indexOf('_expo/static/')) : new URL('/', document.baseURI).href;
}

function loadPdfJs(): Promise<PdfJs> {
  pdfjsPromise ??= import('pdfjs-dist').then((pdfjs) => {
    if (!pdfjs.GlobalWorkerOptions.workerSrc) {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', appBase()).href;
    }
    return pdfjs;
  });
  return pdfjsPromise;
}

function loadDoc(fileUri: string): Promise<PdfDoc> {
  let doc = docs.get(fileUri);
  if (!doc) {
    doc = loadPdfJs().then(async (pdfjs) => {
      const data = new Uint8Array(await (await fetch(fileUri)).arrayBuffer());
      return pdfjs.getDocument({ data }).promise;
    });
    doc.catch(() => docs.delete(fileUri));
    docs.set(fileUri, doc);
  }
  return doc;
}

async function render(fileUri: string, pageIndex: number, widthPx: number): Promise<string> {
  const doc = await loadDoc(fileUri);
  const page = await doc.getPage(pageIndex + 1);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: widthPx / base.width });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  await page.render({ canvas, viewport, background: '#ffffff' }).promise;
  page.cleanup();
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png'),
  );
  return URL.createObjectURL(blob);
}

class QalmInkWebModule extends NativeModule implements QalmInkModuleType {
  renderPdfPage(fileUri: string, pageIndex: number, widthPx: number): Promise<string> {
    const key = `${fileUri}#${pageIndex}@${Math.round(widthPx)}`;
    let png = pages.get(key);
    if (!png) {
      png = render(fileUri, pageIndex, Math.round(widthPx));
      png.catch(() => pages.delete(key));
    }
    remember(key, png);
    return png;
  }
}

export default registerWebModule(QalmInkWebModule, 'QalmInk');
