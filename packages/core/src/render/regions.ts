import { intersects, itemBBox } from '../geometry/bbox';
import { escapeXml } from './text';
import { itemSvg } from './svg';
import type { Page } from '../model/page';
import type { BBox, Item } from '../types';

/** One row of a region image (qink-live.md §2). */
export interface RegionRow {
  pageId: string;
  /** `[1]`, drawn in the left margin. */
  label: string;
  /** Page units. Rows show everything in `fresh`, `context` and `erased`, never clipped (it is their union). */
  box: BBox;
  /** New or changed ink: solid black. */
  fresh: string[];
  /** Existing ink around it: mid grey. */
  context: string[];
  /** Erased strokes (page-unit polylines): faint red, dashed. */
  erased: [number, number][][];
  /** A box crop (`read(box)`, a selection without ink): everything on the page inside `box`, black, clipped to it. */
  clip?: boolean;
  /** The page's unit (≈ a line of handwriting), which sets the scale. */
  unit: number;
  /** `first`: a first look (smaller); `read`: on demand (larger). Default: an update. */
  scale?: 'first' | 'read';
}

const LABEL_W = 44;
const PAD = 8;
/** Pixels per unit (one line of handwriting): updates, first looks and reads. */
export const UNIT_PX = { update: 64, first: 48, read: 72 } as const;
/** Big regions are shrunk to at most this many pixels each, but never below MIN_UNIT_PX per unit. */
export const MAX_ROW_AREA = 480_000;
export const MIN_UNIT_PX = 24;
export const MAX_W = 1600;

const BLACK = '#000000';
const GREY = '#8c8c8c';
const ERASED = '#f0a0a0';

const isHighlighter = (it: Item) => it.type === 'stroke' && it.tool === 'highlighter';
const f = (v: number) => (Math.round(v * 100) / 100).toString();

/** Row scale (px per page unit): its unit at UNIT_PX, shrunk for very big regions and to fit MAX_W. */
export function rowScale(row: Pick<RegionRow, 'box' | 'unit' | 'scale'>): number {
  const w = Math.max(1, row.box[2] - row.box[0]);
  const h = Math.max(1, row.box[3] - row.box[1]);
  let s = UNIT_PX[row.scale ?? 'update'] / row.unit;
  const area = w * h * s * s;
  if (area > MAX_ROW_AREA) s = Math.max(MIN_UNIT_PX / row.unit, Math.sqrt(MAX_ROW_AREA / (w * h)));
  return Math.min(s, (MAX_W - LABEL_W - 2 * PAD) / w);
}

/**
 * Renders region rows as one image: white background, `[n]` labels, new ink black, context grey, erased strokes faint
 * red dashed. Rows may come from several pages (`pages` by id); unknown pages or ids are skipped. Markdown boxes' maths
 * needs MathJax, loaded on demand: `await loadMathFor(...)` with the pages' items first (the server does, in
 * `loadPages`), or it draws as its placeholder.
 */
export function renderRegionsSvg(pages: Record<string, Page>, rows: readonly RegionRow[]): { svg: string; width: number; height: number } {
  let top = 0;
  let width = LABEL_W + 2 * PAD;
  const laid = rows.map((row) => {
    const s = rowScale(row);
    const w = Math.max(1, row.box[2] - row.box[0]);
    const h = Math.max(1, row.box[3] - row.box[1]);
    const rowH = Math.ceil(h * s + 2 * PAD);
    const out = { row, s, top, h: rowH };
    width = Math.max(width, Math.ceil(LABEL_W + w * s + 2 * PAD));
    top += rowH;
    return out;
  });
  const height = Math.max(1, top);

  const parts = laid.map(({ row, s, top, h }, i) => {
    const page = pages[row.pageId];
    const items = page?.items() ?? [];
    const byId = new Map(items.map((it) => [it.id, it]));
    const pick = (ids: string[]) => ids.map((id) => byId.get(id)).filter((it): it is Item => !!it);
    const under = (xs: Item[]) => [...xs].sort((a, b) => Number(isHighlighter(b)) - Number(isHighlighter(a)));
    const b = row.box;
    const tx = LABEL_W + PAD - b[0] * s;
    const ty = top + PAD - b[1] * s;
    let ink: string;
    let clip = '';
    if (row.clip) {
      const inBox = items.filter((it) => it.type !== 'image' && intersects(itemBBox(it), b));
      clip = `<clipPath id="crop${i}"><rect x="${f(b[0])}" y="${f(b[1])}" width="${f(b[2] - b[0])}" height="${f(b[3] - b[1])}"/></clipPath>`;
      ink = under(inBox).map((it) => itemSvg(it, { ink: BLACK })).join('');
    } else {
      const lw = 1.4 / s;
      const erased = row.erased
        .filter((pl) => pl.length)
        .map((pl) => `M${pl.map(([x, y]) => `${f(x)},${f(y)}`).join(' L')}${pl.length === 1 ? ` L${f(pl[0]![0] + 0.5)},${f(pl[0]![1])}` : ''}`)
        .join(' ');
      ink =
        (erased ? `<path d="${erased}" fill="none" stroke="${ERASED}" stroke-width="${f(lw)}" stroke-dasharray="${f(4 / s)} ${f(3 / s)}" stroke-linecap="round" stroke-linejoin="round"/>` : '') +
        under(pick(row.context)).map((it) => itemSvg(it, { ink: GREY })).join('') +
        under(pick(row.fresh)).map((it) => itemSvg(it, { ink: BLACK })).join('');
    }
    return (
      clip +
      (top > 0 ? `<path d="M0,${top} H${width}" stroke="#e0e0e0" stroke-width="1"/>` : '') +
      `<text x="6" y="${(top + h / 2 + 5).toFixed(1)}" font-family="monospace" font-size="14" fill="#000000">${escapeXml(row.label)}</text>` +
      `<g transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${s.toFixed(4)})"${row.clip ? ` clip-path="url(#crop${i})"` : ''}>${ink}</g>`
    );
  });
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect width="${width}" height="${height}" fill="#ffffff"/>${parts.join('')}</svg>`;
  return { svg, width, height };
}
