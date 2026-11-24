import type { Item } from '@qalm/core';

/**
 * Baking: on a dense page, everything except the newest few items is rasterised once into one image (the "base"), and
 * only the items after it (the "tail") are drawn as vectors. react-native-skia replays a canvas's whole recording on
 * every redraw (on Android on the main thread), so with recorded pictures alone a stroke or an undo on a 5000-stroke
 * page re-rasterised all 5000 paths. With a base, a change redraws one image plus a few dozen paths.
 *
 * This file is the pure planning half (what to draw from the base, what to bake next); PageCanvas does the Skia half.
 */

export interface BakeOptions {
  /** Pages with fewer ink items than this are drawn as pictures only (cheap enough, and no image memory). */
  minInk: number;
  /** Newest items always kept out of the base, so undoing them never invalidates it. */
  tailMin: number;
  /** When the tail grows past this, the items before the last `tailMin` are baked onto the base. */
  tailMax: number;
  /** Largest base in device pixels (more and the page draws as pictures, e.g. zoomed far in). */
  maxPixels: number;
}

export const BAKE: BakeOptions = { minInk: 100, tailMin: 16, tailMax: 96, maxPixels: 8_000_000 };

/**
 * Pixels all mounted pages' bases may hold together (4 bytes each), so memory stays bounded at any zoom: about ten
 * pages at 1× on a phone, two or three zoomed in. A page that doesn't fit draws pictures until another page lets go.
 */
export class BakeBudget {
  private held = new Map<object, number>();
  private waiting = new Set<() => void>();
  constructor(readonly maxPixels: number) {}

  /** Whether `owner` may hold a base of `pixels` (what it holds already doesn't count against it). */
  fits(owner: object, pixels: number): boolean {
    let others = 0;
    for (const [o, p] of this.held) if (o !== owner) others += p;
    return others + pixels <= this.maxPixels;
  }

  hold(owner: object, pixels: number): void {
    this.held.set(owner, pixels);
  }

  release(owner: object): void {
    if (!this.held.delete(owner)) return;
    for (const f of [...this.waiting]) f();
  }

  /** Called whenever a base is released (pages that didn't fit try again). */
  onRelease(f: () => void): () => void {
    this.waiting.add(f);
    return () => void this.waiting.delete(f);
  }

  get total(): number {
    let n = 0;
    for (const p of this.held.values()) n += p;
    return n;
  }
}

export const bakeBudget = new BakeBudget(16_000_000);

/** A baked base: the items it holds (a prefix of the page's items, same objects) and what it was drawn with. */
export interface Baked {
  items: readonly Item[];
  /** Background inputs (paper, PDF image, comment highlights, fonts). A different key means re-bake, not invalid. */
  key: string;
  /** Size in device pixels. */
  w: number;
  h: number;
}

export interface BakeJob {
  /** Bake items [from, to) onto the current base (`full`: from a blank surface, `from` is 0). */
  from: number;
  to: number;
  full: boolean;
}

export interface BakePlan {
  /** Draw the current base (possibly stale in background or resolution, never in ink). */
  use: boolean;
  /** Items from here on are drawn as vectors (0 when the base isn't used). */
  tailStart: number;
  /** The next bake to run in the background, if any. */
  job: BakeJob | null;
  /** Baking applies to this page (dense enough, small enough). False: drop any base, draw pictures. */
  enabled: boolean;
}

/** Number of leading items that are the same objects in both lists. */
export function commonPrefix(a: readonly unknown[], b: readonly unknown[]): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

export function inkCount(items: readonly Item[]): number {
  let n = 0;
  for (const it of items) if (it.type === 'stroke' || it.type === 'shape') n++;
  return n;
}

/**
 * Plans what to draw from the base and what to bake next.
 * - `bakeable(i)`: whether item i can go in the base now (images can't; text only once the fonts have loaded). The base
 *   stops before the first item that can't, so z-order stays exact.
 * - `live`: ids of a selection being dragged; they are drawn with a transform, so they (and what's above them) stay out.
 */
export function planBake(
  base: Baked | null,
  items: readonly Item[],
  target: { key: string; w: number; h: number },
  bakeable: (it: Item) => boolean,
  live: ReadonlySet<string> | null,
  opts: BakeOptions = BAKE,
): BakePlan {
  if (target.w * target.h > opts.maxPixels || target.w <= 0 || target.h <= 0 || inkCount(items) < opts.minInk) {
    return { use: false, tailStart: 0, job: null, enabled: false };
  }
  // The base can't hold the first unbakeable or live item, or anything above it (z-order).
  let stop = items.length;
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    if (!bakeable(it) || live?.has(it.id)) {
      stop = i;
      break;
    }
  }
  // How far a new bake reaches: not the newest `tailMin` either, so undoing them keeps the base.
  const limit = Math.min(stop, Math.max(0, items.length - opts.tailMin));
  const valid = !!base && base.items.length <= stop && commonPrefix(base.items, items) === base.items.length;
  if (!valid) {
    return { use: false, tailStart: 0, job: limit > 0 ? { from: 0, to: limit, full: true } : null, enabled: true };
  }
  const start = base.items.length;
  const fresh = base.key === target.key && base.w === target.w && base.h === target.h;
  if (!fresh) return { use: true, tailStart: start, job: limit > 0 ? { from: 0, to: limit, full: true } : null, enabled: true };
  const grow = items.length - start > opts.tailMax && limit > start;
  return { use: true, tailStart: start, job: grow ? { from: start, to: limit, full: false } : null, enabled: true };
}

/**
 * Whether a bake in progress (over `snapshot[0, to)`, with `key` and size) still produces a usable base for `items`:
 * the items it is drawing are still the page's leading items.
 */
export function jobStillValid(snapshot: readonly Item[], to: number, items: readonly Item[]): boolean {
  return to <= items.length && commonPrefix(snapshot.slice(0, to), items) >= to;
}
