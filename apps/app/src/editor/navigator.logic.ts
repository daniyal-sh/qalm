/** Page navigator maths: layout of the thumbnail list/grid, filtering, drag-to-reorder targets, go-to and keys. */
import type { PageInfo } from '@qalm/core';

/** Windows at least this wide show the navigator as a sidebar beside the pages; narrower ones as a full-screen grid. */
export const NAV_SIDEBAR_MIN = 900;
export const NAV_SIDEBAR_W = 224;
export const NAV_PAD = 12;
export const NAV_GAP = 12;
/** Height of the label row under a thumbnail (page number, bookmark). */
export const NAV_LABEL_H = 36;

/** px around a thumbnail inside its cell: the current-page ring (2) and the gap between it and the page (2). */
export const NAV_RING = 4;

export type NavMode = 'sidebar' | 'grid';
export type NavFilter = 'all' | 'bookmarks';

export interface NavLayout {
  columns: number;
  /** px width of a cell (and its thumbnail box) */
  cellW: number;
  /** px height of a thumbnail box: the tallest page's aspect, so every row is the same height */
  thumbH: number;
  /** px from one row's top to the next */
  rowH: number;
}

export function navLayout(width: number, mode: NavMode, pages: Pick<PageInfo, 'size'>[]): NavLayout {
  const inner = Math.max(80, width - NAV_PAD * 2);
  const columns = mode === 'sidebar' ? 1 : Math.max(2, Math.floor((inner + NAV_GAP) / (150 + NAV_GAP)));
  const cellW = Math.floor((inner - NAV_GAP * (columns - 1)) / columns);
  const aspect = pages.reduce((m, p) => Math.max(m, p.size.h / p.size.w), 0) || 842 / 595;
  const thumbH = Math.round(cellW * Math.min(aspect, 2));
  return { columns, cellW, thumbH, rowH: thumbH + NAV_LABEL_H + NAV_GAP };
}

/**
 * The thumbnail's box for a page of `size`: its own aspect ratio, as large as fits the cell (less the ring), so a page
 * is never cropped and every page in a row lines up on the same centre.
 */
export function thumbBox(size: { w: number; h: number }, layout: Pick<NavLayout, 'cellW' | 'thumbH'>): { w: number; h: number } {
  const aspect = size.h / size.w;
  const maxW = Math.max(1, layout.cellW - NAV_RING * 2);
  const maxH = Math.max(1, layout.thumbH - NAV_RING * 2);
  const w = Math.min(maxW, maxH / aspect);
  return { w: Math.floor(w), h: Math.floor(w * aspect) };
}

export interface NavEntry {
  info: PageInfo;
  /** index in the notebook */
  index: number;
}

export function navEntries(pages: PageInfo[], filter: NavFilter): NavEntry[] {
  const all = pages.map((info, index) => ({ info, index }));
  return filter === 'bookmarks' ? all.filter((e) => e.info.bookmarked) : all;
}

/** Row index of the entry `i` (for scrolling it into view). */
export const rowOf = (i: number, layout: NavLayout) => Math.floor(i / layout.columns);

/**
 * The gap (0..count) a dragged thumbnail would drop into, for a pointer at (x, y) in list content coordinates:
 * before the cell under the pointer if it is in that cell's first half (left half in a grid, top half in a list).
 */
export function dropGap(x: number, y: number, layout: NavLayout, count: number): number {
  const row = Math.max(0, Math.floor((y - NAV_PAD) / layout.rowH));
  if (layout.columns === 1) {
    const within = y - NAV_PAD - row * layout.rowH;
    return Math.min(count, row + (within > (layout.thumbH + NAV_LABEL_H) / 2 ? 1 : 0));
  }
  const colW = layout.cellW + NAV_GAP;
  const col = Math.max(0, Math.min(layout.columns - 1, Math.floor((x - NAV_PAD) / colW)));
  const within = x - NAV_PAD - col * colW;
  return Math.min(count, row * layout.columns + col + (within > layout.cellW / 2 ? 1 : 0));
}

/** `Notebook.movePage` index for dropping page `from` into gap `gap` (the page leaves its own slot first). */
export function moveIndex(from: number, gap: number): number {
  return gap > from ? gap - 1 : gap;
}

/** "12" -> index 11, clamped to the notebook; null if not a number. */
export function parseGoTo(text: string, count: number): number | null {
  const n = Number.parseInt(text.trim(), 10);
  if (!Number.isFinite(n) || count === 0) return null;
  return Math.min(count, Math.max(1, n)) - 1;
}

/** Page keys: PageUp / PageDown step one page, Home / End go to the first / last. Null for other keys. */
export function keyTarget(key: string, current: number, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case 'PageUp':
      return Math.max(0, current - 1);
    case 'PageDown':
      return Math.min(count - 1, current + 1);
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}
