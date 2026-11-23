import { itemBBox } from './bbox';
import type { BBox, Item, Paper, Size } from '../types';

/**
 * Regions (qink-live.md §2): what an agent is sent instead of lines. Pure functions of boxes.
 *
 * Everything is measured in **units**: the typical height of handwriting on the page (`pageUnit`). Changed strokes are
 * clustered (`clusterBoxes`), and each cluster pulls in the existing ink around it (`contextFor`) so the agent sees
 * what the new writing belongs to. No stroke is ever split or clipped: a region's box is the union of its strokes.
 */

/** Clusters of changed strokes closer than this many units are one region. */
export const CLUSTER_GAP = 2;
/** Existing strokes within this many units of a changed stroke are context. */
export const NEAR = 0.5;
/** Context grows along the row: horizontal gap under this many units, with vertical overlap. */
export const ROW_GAP = 1.5;
/** ... at least this fraction of the smaller height. */
export const ROW_OVERLAP = 0.3;
/** ... and only through strokes whose centre is within this many units of the changed strokes' rows. */
export const ROW_BAND = 0.5;
/** At most this many context strokes per region (the first ones found, nearest first). */
export const MAX_CONTEXT = 600;
/** Units are clamped to this range (page units, PDF points). */
export const UNIT_MIN = 12;
export const UNIT_MAX = 48;
/** Without ink or ruling to measure. */
export const DEFAULT_UNIT = 24;
/** Ruled paper's line spacing and grid/dot spacing (paper.ts). */
const RULED = 24;
const GRID = 18;
/** A stroke's height × this ≈ a line of handwriting: the median stroke is about x-height, a ruled line ~2.5 of those. */
const HEIGHT_TO_UNIT = 2.5;
/** Strokes lower than this (dots, dashes) don't count towards the median height. */
const MIN_HEIGHT = 3;

/** Strokes and shapes: the ink regions are made of. Text boxes and images are not ink. */
export const isInk = (it: Item): boolean => it.type === 'stroke' || it.type === 'shape';

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

const clamp = (v: number) => Math.min(UNIT_MAX, Math.max(UNIT_MIN, v));

/**
 * The page's unit: the ruling on ruled, Cornell, grid and dotted paper; otherwise 2.5 × the median stroke height
 * (≈ one line of handwriting; tall strokes like ∫ and tiny dots don't move a median). Clamped to 12–48.
 */
export function pageUnit(paper: Paper | undefined, boxes: readonly BBox[]): number {
  if (paper === 'ruled' || paper === 'cornell') return RULED;
  if (paper === 'grid' || paper === 'dotted') return GRID;
  const hs = boxes.map((b) => b[3] - b[1]).filter((h) => h >= MIN_HEIGHT);
  if (!hs.length) return DEFAULT_UNIT;
  return clamp(HEIGHT_TO_UNIT * median(hs));
}

/** The gap between two boxes: 0 when they overlap, else the larger of the horizontal and vertical gaps. */
export function boxGap(a: BBox, b: BBox): number {
  const dx = Math.max(0, b[0] - a[2], a[0] - b[2]);
  const dy = Math.max(0, b[1] - a[3], a[1] - b[3]);
  return Math.max(dx, dy);
}

/** Boxes bucketed on a square grid, for "what is near this box" queries. */
class Buckets {
  private cells = new Map<string, number[]>();
  constructor(private readonly boxes: readonly BBox[], private readonly size: number) {
    boxes.forEach((b, i) => this.cover(b, (k) => {
      let c = this.cells.get(k);
      if (!c) this.cells.set(k, (c = []));
      c.push(i);
    }));
  }

  private cover(b: BBox, fn: (k: string) => void): void {
    const s = this.size;
    const x0 = Math.floor(b[0] / s), x1 = Math.floor(b[2] / s), y0 = Math.floor(b[1] / s), y1 = Math.floor(b[3] / s);
    // A huge box (a page-wide sketch) covers many cells: fine, it's rare and bounded by the page.
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) fn(`${x},${y}`);
  }

  /** Indices of boxes within `d` of `b` (candidates; callers check exactly). */
  near(b: BBox, d: number): number[] {
    const out = new Set<number>();
    this.cover([b[0] - d, b[1] - d, b[2] + d, b[3] + d], (k) => {
      for (const i of this.cells.get(k) ?? []) out.add(i);
    });
    return [...out];
  }
}

function union(boxes: readonly BBox[], idx: Iterable<number>): BBox {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const i of idx) {
    const b = boxes[i]!;
    if (b[0] < x0) x0 = b[0];
    if (b[1] < y0) y0 = b[1];
    if (b[2] > x1) x1 = b[2];
    if (b[3] > y1) y1 = b[3];
  }
  return [x0, y0, x1, y1];
}

/**
 * Groups boxes whose gap is under `maxGap` (transitively), then merges groups whose bounding boxes overlap, so regions
 * never overlap each other. Groups come out in reading order (top to bottom, then left to right), each sorted.
 */
export function clusterBoxes(boxes: readonly BBox[], maxGap: number): number[][] {
  const parent = boxes.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!;
    return i;
  };
  const join = (a: number, b: number) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  const grid = new Buckets(boxes, Math.max(1, maxGap));
  boxes.forEach((b, i) => {
    for (const j of grid.near(b, maxGap)) if (j > i && boxGap(b, boxes[j]!) < maxGap) join(i, j);
  });
  let groups = collect(parent.map((_, i) => find(i)));
  // Overlapping bounding boxes: merge until none overlap (few groups, so quadratic is fine).
  for (let merged = true; merged; ) {
    merged = false;
    const bbs = groups.map((g) => union(boxes, g));
    outer: for (let a = 0; a < groups.length; a++) {
      for (let b = a + 1; b < groups.length; b++) {
        if (boxGap(bbs[a]!, bbs[b]!) === 0) {
          groups[a] = groups[a]!.concat(groups[b]!).sort((x, y) => x - y);
          groups.splice(b, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
  return sortReading(groups.map((g) => ({ g, box: union(boxes, g) }))).map((x) => x.g);
}

function collect(roots: number[]): number[][] {
  const m = new Map<number, number[]>();
  roots.forEach((r, i) => {
    let g = m.get(r);
    if (!g) m.set(r, (g = []));
    g.push(i);
  });
  return [...m.values()];
}

/** Top to bottom (by top edge), then left to right. */
export function sortReading<T extends { box: BBox }>(xs: T[]): T[] {
  return [...xs].sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0]);
}

/**
 * The existing ink a region of changed strokes (`seeds`) is about, as indices into `others`:
 * 1. every stroke that overlaps or is within `NEAR` (½ unit) of a seed;
 * 2. then, transitively, strokes on the same row as anything included so far: horizontal gap under `ROW_GAP` (1½
 *    units) and vertical overlap of at least `ROW_OVERLAP` of the smaller height, so writing next to or over an
 *    equation pulls in the whole equation. Growth only goes through strokes whose centre is within `ROW_BAND` (½ unit)
 *    of the seeds' rows (their vertical extent), so it follows the row and can't spread down the page, and stops at
 *    `MAX_CONTEXT` strokes.
 */
export function contextFor(seeds: readonly BBox[], others: readonly BBox[], unit: number): number[] {
  if (!seeds.length || !others.length) return [];
  const grid = new Buckets(others, 2 * unit);
  const taken = new Set<number>();
  const queue: BBox[] = [];
  const near = NEAR * unit;
  for (const s of seeds) {
    for (const j of grid.near(s, near)) {
      if (taken.has(j) || boxGap(s, others[j]!) > near) continue;
      taken.add(j);
    }
  }
  const lo = Math.min(...seeds.map((s) => s[1])) - ROW_BAND * unit;
  const hi = Math.max(...seeds.map((s) => s[3])) + ROW_BAND * unit;
  queue.push(...seeds, ...[...taken].map((j) => others[j]!));
  const rowGap = ROW_GAP * unit;
  for (let q = 0; q < queue.length && taken.size < MAX_CONTEXT; q++) {
    const m = queue[q]!;
    for (const j of grid.near(m, rowGap)) {
      if (taken.has(j)) continue;
      const c = others[j]!;
      const cy = (c[1] + c[3]) / 2;
      if (cy < lo || cy > hi) continue;
      const dx = Math.max(0, c[0] - m[2], m[0] - c[2]);
      const over = Math.min(c[3], m[3]) - Math.max(c[1], m[1]);
      if (dx >= rowGap || over < ROW_OVERLAP * Math.min(c[3] - c[1], m[3] - m[1])) continue;
      taken.add(j);
      queue.push(c);
      if (taken.size >= MAX_CONTEXT) break;
    }
  }
  return [...taken].sort((a, b) => a - b);
}

/** The ink boxes of `items` (strokes and shapes only). */
export function inkBoxes(items: readonly Item[]): { id: string; box: BBox }[] {
  return items.filter(isInk).map((it) => ({ id: it.id, box: itemBBox(it) }));
}

// ---- the agent's coordinate grid: 0–1000 across the page width, y in the same units ----

/** Grid units per page unit. */
export const gridScale = (size: Size) => 1000 / size.w;

/** A page's size in grid units: `1000x1414` for A4 portrait. */
export function gridSize(size: Size): string {
  return `${1000}x${Math.round(size.h * gridScale(size))}`;
}

/** A page box as integer grid `[x, y, w, h]` (outward-rounded, so the box still holds all of its ink). */
export function toGrid(box: BBox, size: Size): [number, number, number, number] {
  const s = gridScale(size);
  const x0 = Math.floor(box[0] * s), y0 = Math.floor(box[1] * s);
  const x1 = Math.ceil(box[2] * s), y1 = Math.ceil(box[3] * s);
  return [x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0)];
}

/** Grid `[x, y, w, h]` back to a page box. */
export function fromGrid(g: readonly [number, number, number, number], size: Size): BBox {
  const s = gridScale(size);
  return [g[0] / s, g[1] / s, (g[0] + g[2]) / s, (g[1] + g[3]) / s];
}

/** `@120,300 260x80`: a region's place in an update line. */
export function gridPlace(box: BBox, size: Size): string {
  const [x, y, w, h] = toGrid(box, size);
  return `@${x},${y} ${w}x${h}`;
}

/** `p6@120,300,260,80`: a box ref (agents pass these back to read, transcribe and comment). */
export function boxRef(pos: number, box: BBox, size: Size): string {
  return `p${pos}@${toGrid(box, size).join(',')}`;
}
