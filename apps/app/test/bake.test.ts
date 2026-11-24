// Baked page bases (modules/qalm-ink/src/bake.ts): what a change on a dense page redraws, and when the base is rebuilt.
import { createUndoManager, Page, type Item } from '@qalm/core';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { BAKE, BakeBudget, commonPrefix, jobStillValid, planBake, type Baked, type BakeOptions } from '../../../modules/qalm-ink/src/bake';
import { A4, fillPage } from '../src/bench/gen';

const OPTS: BakeOptions = { minInk: 10, tailMin: 4, tailMax: 12, maxPixels: 1_000_000 };
const SIZE = { key: 'k', w: 600, h: 850 };
const s = (id: string): Item => ({ id, type: 'stroke', tool: 'pen', color: '#000', width: 1, points: [], bbox: [0, 0, 1, 1], createdAt: 0 });
const strokes = (n: number, from = 0) => Array.from({ length: n }, (_, i) => s(`s${from + i}`));
const inkOnly = (it: Item) => it.type === 'stroke' || it.type === 'shape';
const plan = (base: Baked | null, items: Item[], target = SIZE, live: Set<string> | null = null, bakeable = inkOnly) => planBake(base, items, target, bakeable, live, OPTS);
/** What a finished bake job leaves behind. */
const baked = (items: Item[], to: number, target = SIZE): Baked => ({ items: items.slice(0, to), key: target.key, w: target.w, h: target.h });

describe('bake plan', () => {
  it('leaves sparse pages and oversized bases to pictures', () => {
    expect(plan(null, strokes(9)).enabled).toBe(false);
    expect(plan(null, strokes(40), { key: 'k', w: 2000, h: 2000 }).enabled).toBe(false);
    expect(BAKE.maxPixels).toBeGreaterThan(1080 * 1528 * 4); // a Pixel 8 page up to 2× zoom
  });

  it('bakes everything but the newest few on first sight', () => {
    const items = strokes(40);
    const p = plan(null, items);
    expect(p).toMatchObject({ use: false, tailStart: 0, job: { from: 0, to: 36, full: true }, enabled: true });
  });

  it('a new stroke or an undo inside the tail only redraws the tail', () => {
    let items = strokes(40);
    const base = baked(items, 36);
    // Draw: the base stays, the tail grows; nothing is baked until the tail passes tailMax.
    for (let n = 1; n <= 8; n++) {
      items = [...items, s(`new${n}`)];
      const p = plan(base, items);
      expect(p).toMatchObject({ use: true, tailStart: 36, job: null });
    }
    // Undo the strokes and then the 4 kept-back ones: still the same base.
    for (let n = 0; n < 12; n++) {
      items = items.slice(0, -1);
      expect(plan(base, items)).toMatchObject({ use: true, tailStart: 36, job: null });
    }
  });

  it('grows the base incrementally once the tail is long', () => {
    const items = strokes(53);
    const p = plan(baked(items, 36), items);
    expect(p).toMatchObject({ use: true, tailStart: 36, job: { from: 36, to: 49, full: false } });
  });

  it('undo past the tail, or erasing an older stroke, invalidates the base and plans one full re-bake', () => {
    const items = strokes(40);
    const base = baked(items, 36);
    const undone = items.slice(0, 35);
    expect(plan(base, undone)).toMatchObject({ use: false, tailStart: 0, job: { from: 0, to: 31, full: true } });
    const erased = items.filter((it) => it.id !== 's3');
    expect(plan(base, erased)).toMatchObject({ use: false, job: { from: 0, to: 35, full: true } });
  });

  it('keeps showing a base drawn at another zoom or with another background while it re-bakes', () => {
    const items = strokes(40);
    const base = baked(items, 36);
    expect(plan(base, items, { key: 'k', w: 700, h: 990 })).toMatchObject({ use: true, tailStart: 36, job: { from: 0, to: 36, full: true } });
    expect(plan(base, items, { ...SIZE, key: 'pdf-loaded' })).toMatchObject({ use: true, job: { full: true } });
  });

  it('stops the base before an image or a text box it cannot draw yet', () => {
    const img: Item = { id: 'img', type: 'image', x: 0, y: 0, w: 10, h: 10, assetId: 'a' };
    const items = [...strokes(20), img, ...strokes(20, 20)];
    expect(plan(null, items).job).toMatchObject({ from: 0, to: 20, full: true });
    // With the base at the image, the rest stays in the tail (vectors): correct z-order, no bake.
    expect(plan(baked(items, 20), items)).toMatchObject({ use: true, tailStart: 20, job: null });
  });

  it('a selection being dragged stays out of the base', () => {
    const items = strokes(40);
    expect(plan(null, items, SIZE, new Set(['s10'])).job).toMatchObject({ to: 10 });
    // Dragging ink that is already baked: the base can't be used (it holds that ink at its old place).
    expect(plan(baked(items, 36), items, SIZE, new Set(['s10'])).use).toBe(false);
    // Dragging only tail ink keeps it.
    expect(plan(baked(items, 36), items, SIZE, new Set(['s38'])).use).toBe(true);
  });

  it('a running bake survives strokes added on top, not edits underneath it', () => {
    const items = strokes(40);
    expect(jobStillValid(items, 36, [...items, s('x')])).toBe(true);
    expect(jobStillValid(items, 36, items.slice(0, 30))).toBe(false);
    expect(jobStillValid(items, 36, items.filter((it) => it.id !== 's5'))).toBe(false);
    expect(jobStillValid(items, 36, items.filter((it) => it.id !== 's38'))).toBe(true);
  });
});

describe('bake plan on a real 5000-stroke page', () => {
  it('a stroke and its undo keep every baked item (same objects), so only the tail is redrawn', () => {
    const doc = new Y.Doc();
    fillPage(doc, 5000, A4, 2);
    const page = new Page(doc);
    const undo = createUndoManager(page);
    const before = page.items();
    const target = { key: 'k', w: 945, h: 1337 };
    const p0 = planBake(null, before, target, inkOnly, null);
    expect(p0.job).toMatchObject({ from: 0, to: before.length - BAKE.tailMin, full: true });
    const base: Baked = { items: before.slice(0, p0.job!.to), key: 'k', w: 945, h: 1337 };

    page.addItem({ ...(before[0] as Extract<Item, { type: 'stroke' }>), id: 'fresh' });
    const after = page.items();
    expect(commonPrefix(before, after)).toBe(before.length);
    expect(planBake(base, after, target, inkOnly, null)).toMatchObject({ use: true, tailStart: base.items.length, job: null });

    undo.undo();
    const undone = page.items();
    expect(undone).toHaveLength(before.length);
    expect(planBake(base, undone, target, inkOnly, null)).toMatchObject({ use: true, tailStart: base.items.length, job: null });
  });
});

describe('bake budget', () => {
  it('bounds the pixels all bases hold together, and lets a waiting page retry on release', () => {
    const b = new BakeBudget(100);
    const [p1, p2, p3] = [{}, {}, {}];
    expect(b.fits(p1, 60)).toBe(true);
    b.hold(p1, 60);
    expect(b.fits(p2, 50)).toBe(false);
    expect(b.fits(p1, 90)).toBe(true); // re-baking at another zoom replaces its own base
    expect(b.fits(p2, 40)).toBe(true);
    b.hold(p2, 40);
    let retried = 0;
    const off = b.onRelease(() => retried++);
    expect(b.fits(p3, 10)).toBe(false);
    b.release(p1);
    expect(retried).toBe(1);
    expect(b.fits(p3, 10)).toBe(true);
    b.release(p1); // not held: no wake-up
    expect(retried).toBe(1);
    off();
    b.release(p2);
    expect(retried).toBe(1);
    expect(b.total).toBe(0);
  });
});
