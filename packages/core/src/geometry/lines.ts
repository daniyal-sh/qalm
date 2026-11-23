import type { BBox, Line } from '../types';

/**
 * Line grouping rules (tech-spec §2, "Line assignment"). Pure functions of boxes, shared by `Page`'s incremental line
 * index and the per-item reference model in the tests, so both decide the same way.
 *
 * Handwriting, and maths in particular, doesn't fit plain box overlap: an exponent sits above its base, an integral
 * sign spans two ruled lines, and `u = x²   du = 2x dx` is one row with a wide gap. So a line is matched by its
 * **band**: the median top and median bottom of its items. Outliers (an exponent, a subscript, a tall ∫, a long
 * fraction bar) don't move the median, so they can't drag the band onto the next row.
 */

/** A line's writing band: [top, bottom] on the page. */
export type Band = [top: number, bottom: number];

/** Line height assumed while a page has no lines yet. */
export const DEFAULT_LINE_HEIGHT = 24;
/** Rule A, near: horizontal gap up to this × the band height (letters and words). */
const NEAR_GAP = 1.5;
/** Rule A, same row: horizontal gap up to this × the page's line height, with strong vertical overlap. */
const ROW_GAP = 5;
const ROW_OVERLAP = 0.75;
/** Rule B, attachments: no taller than the band, within this × band height above/below it and beside its ink. */
const ATTACH_DIST = 0.4;
const ATTACH_GAP = 0.5;
/** Strokes taller than this × the page's line height are drawings, unless they are tall symbols. */
const TALL = 2.5;
/** Tall symbols (∫ ∑ brackets): no wider than this × their height and no taller than `TALL_MAX` line heights. */
const TALL_NARROW = 0.6;
const TALL_MAX = 6;

function median(xs: number[]): number {
  const s = xs.sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** The band of a line's item boxes: median top, median bottom. Order-independent. */
export function bandOf(boxes: readonly BBox[]): Band {
  if (!boxes.length) return [0, 0];
  return [median(boxes.map((b) => b[1])), median(boxes.map((b) => b[3]))];
}

/** The median height of the page's lines (not drawings): its typical line height. */
export function medianLineHeight(lines: { kind: Line['kind']; bbox: BBox }[]): number {
  const xs = lines.filter((l) => l.kind === 'line').map((l) => l.bbox[3] - l.bbox[1]);
  return xs.length ? median(xs) : DEFAULT_LINE_HEIGHT;
}

/**
 * Whether an item with bbox `b` (a stroke) is a drawing rather than part of a line: taller than 2.5 line heights,
 * unless it is a tall symbol (narrow, at most 6 line heights: ∫, ∑, Π, brackets, a radical's stem).
 */
export function isDrawingBox(b: BBox, ref: number): boolean {
  const h = b[3] - b[1];
  if (h <= TALL * ref) return false;
  return !(b[2] - b[0] <= TALL_NARROW * h && h <= TALL_MAX * ref);
}

/**
 * How well an item with bbox `b` fits a line (its bbox and band) on a page whose line height is `ref`, or null if it
 * doesn't. Lower is better, compared in order: vertical distance from the band, horizontal gap, distance between
 * centres. An item fits when:
 * - **A, same row:** it overlaps the band vertically by at least half the smaller height and the horizontal gap is at
 *   most 1.5 band heights; or it overlaps by at least 75% and the gap is at most 5 line heights (two expressions side
 *   by side on one ruled line). Tall symbols spanning the band fit this way too.
 * - **B, attachment:** it is no taller than the band, beside or over the line's ink (gap ≤ ½ band height) and at most
 *   0.4 band heights above or below the band: exponents, subscripts, dots, accents, bars, limits.
 */
export function lineFit(b: BBox, line: BBox, band: Band, ref: number): [number, number, number] | null {
  const hb = b[3] - b[1];
  const hl = Math.max(1e-6, band[1] - band[0]);
  const hm = Math.min(hb, hl);
  const over = Math.min(b[3], band[1]) - Math.max(b[1], band[0]);
  const gap = Math.max(0, Math.max(b[0], line[0]) - Math.min(b[2], line[2]));
  const dist = Math.max(0, -over);
  const fits =
    (over >= 0.5 * hm && gap <= NEAR_GAP * hl) ||
    (over >= ROW_OVERLAP * hm && gap <= ROW_GAP * ref) ||
    (hb <= hl && dist <= ATTACH_DIST * hl && gap <= ATTACH_GAP * hl);
  if (!fits) return null;
  return [dist, gap, Math.abs(b[1] + b[3] - band[0] - band[1]) / 2];
}

/** Lexicographic comparison of two `lineFit` scores. */
export function compareFit(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}

/**
 * Lines in reading order: row by row, top to bottom, then left to right. A row starts at the topmost remaining line
 * (by the centre of its band); lines whose band centre falls inside that line's band are on the same row. Used for
 * labels and everything Q-ink lists, so the order is the same everywhere.
 */
export function readingOrder<T extends Pick<Line, 'key' | 'kind' | 'bbox' | 'band'>>(lines: readonly T[]): T[] {
  const span = (l: T): Band => (l.band && l.kind === 'line' ? l.band : [l.bbox[1], l.bbox[3]]);
  const mid = (l: T) => {
    const s = span(l);
    return (s[0] + s[1]) / 2;
  };
  const byKey = (a: T, b: T) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const sorted = [...lines].sort((a, b) => mid(a) - mid(b) || a.bbox[0] - b.bbox[0] || byKey(a, b));
  const out: T[] = [];
  for (let i = 0; i < sorted.length; ) {
    const s = span(sorted[i]!);
    // A drawing's row is narrower than its box, so a tall sketch doesn't swallow the rows beside it.
    const lo = sorted[i]!.kind === 'line' ? s[0] : mid(sorted[i]!) - (s[1] - s[0]) / 4;
    const hi = sorted[i]!.kind === 'line' ? s[1] : mid(sorted[i]!) + (s[1] - s[0]) / 4;
    let j = i + 1;
    while (j < sorted.length && mid(sorted[j]!) >= lo && mid(sorted[j]!) <= hi) j++;
    out.push(...sorted.slice(i, j).sort((a, b) => a.bbox[0] - b.bbox[0] || byKey(a, b)));
    i = j;
  }
  return out;
}
