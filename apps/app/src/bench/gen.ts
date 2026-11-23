/**
 * Benchmark data: deterministic handwriting-like page docs and big notebooks (scripts/bench, test/*.bench.ts).
 * Writes the page doc layout of `Page` directly (items, order and, optionally, a reading per row), because building
 * thousands of strokes through `addItem` one by one would take minutes.
 */
import { createNotebookDoc, encodePoints, LOCAL_ORIGIN, Notebook, type BBox, type InkPoint, type Size } from '@qalm/core';
import * as Y from 'yjs';

/** Small deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One glyph-sized squiggle of `n` points around (x, y). */
export function glyph(r: () => number, x: number, y: number, n: number): InkPoint[] {
  const pts: InkPoint[] = [];
  const w = 6 + r() * 8;
  const h = 8 + r() * 8;
  const f = 1 + r() * 2;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    pts.push({
      x: x + t * w + Math.sin(t * Math.PI * 2 * f) * 2,
      y: y + Math.cos(t * Math.PI * 2 * f) * h * 0.5 + h * 0.5,
      p: 0.4 + 0.4 * Math.sin(t * Math.PI),
      tilt: Math.PI / 3,
      az: 0.5,
      t: i * 8,
    });
  }
  return pts;
}

function bboxOf(pts: InkPoint[], width: number): BBox {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  const r = width / 2;
  return [x0 - r, y0 - r, x1 + r, y1 + r];
}

/**
 * Fills a page doc with `strokes` handwriting-like strokes in rows (wrapping back to the top when the page is full,
 * so dense pages overlap like heavily annotated ones). With `readings`, each row gets an agent's reading.
 */
export function fillPage(doc: Y.Doc, strokes: number, size: Size, seed = 1, pointsPerStroke = 32, readings = false): void {
  const r = rng(seed);
  const items = doc.getMap<Y.Map<unknown>>('items');
  const order = doc.getArray<string>('order');
  const readingMap = doc.getMap<Y.Map<unknown>>('readings');
  const rowH = 28;
  const rows = Math.floor((size.h - 80) / rowH);
  doc.transact(() => {
    let x = 40;
    let row = 0;
    let pass = 0;
    let rowIds: string[] = [];
    const ids: string[] = [];
    const endRow = () => {
      if (!readings || !rowIds.length) return;
      const e = new Y.Map<unknown>();
      readingMap.set(`r-${rowIds[0]}`, e);
      e.set('id', `r-${rowIds[0]}`);
      e.set('ids', rowIds);
      e.set('text', 'x + 1');
      e.set('src', 'agent');
      e.set('updatedAt', 1);
    };
    for (let i = 0; i < strokes; i++) {
      const id = `s${seed}-${i}`;
      const y = 50 + row * rowH + pass * 5;
      const pts = glyph(r, x, y, pointsPerStroke + Math.floor(r() * 12));
      const width = 1.8;
      const m = new Y.Map<unknown>();
      items.set(id, m);
      m.set('id', id);
      m.set('type', 'stroke');
      m.set('tool', 'pen');
      m.set('color', '#27272a');
      m.set('width', width);
      m.set('points', encodePoints(pts));
      m.set('bbox', bboxOf(pts, width));
      m.set('createdAt', 1_700_000_000_000 + i);
      m.set('style', 'fountain');
      m.set('smoothing', 2);
      ids.push(id);
      rowIds.push(id);
      x += 12 + r() * 6;
      if (x > size.w - 50) {
        x = 40;
        endRow();
        rowIds = [];
        row++;
        if (row >= rows) {
          row = 0;
          pass = (pass + 1) % 4;
        }
      }
    }
    endRow();
    order.push(ids);
  }, LOCAL_ORIGIN);
}

export interface MixedSpec {
  id: string;
  title: string;
  pages: number;
  /** strokes on page i (0 = blank) */
  strokesOn(i: number): number;
}

/** The default mixed notebook: 300 pages; page 0 has 3000 strokes, page 1 5000, every 30th 3000, every 10th 300. */
export const MIXED: MixedSpec = {
  id: 'bench-mixed',
  title: 'bench: 300 mixed pages',
  pages: 300,
  strokesOn: (i) => (i === 1 ? 5000 : i === 0 || i % 30 === 5 ? 3000 : i % 10 === 2 ? 300 : 0),
};

export const A4: Size = { w: 595, h: 842 };

/** The index doc for a mixed notebook; page ids are `p{i}`. */
export function buildMixedIndex(spec: MixedSpec): Y.Doc {
  const doc = createNotebookDoc({ id: spec.id, title: spec.title, cover: '#4338ca', paper: 'ruled', paperColor: 'white', size: A4 });
  const nb = new Notebook(doc);
  doc.transact(() => {
    const first = nb.pages().map((p) => p.id);
    for (let i = 0; i < spec.pages; i++) nb.addPage({ id: `p${i}` });
    for (const id of first) nb.removePage(id);
  }, LOCAL_ORIGIN);
  return doc;
}
