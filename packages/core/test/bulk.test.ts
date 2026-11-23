// Bulk edits: line assignment keeps its grouping up to date within (and between) transactions instead of re-reading
// the whole page per item. These tests run the same edits on the current `Page` and on the old implementation
// (`LegacyPage`, a verbatim copy) and require identical lines, keys, item order and doc state, except lines' saved
// readings: those now follow the rule checked by `checkReadings` (kept when a line's items are the same at the end of
// a transaction as at its start; the old code cleared them on any change, e.g. a move).
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { LOCAL_ORIGIN, Page, transformPatch } from '../src';
import type { Item, Line, ShapeItem, Sim, StrokeItem, TextItem, TextSrc } from '../src';
import { LegacyPage } from './legacyPage';
import { pts, stroke } from './helpers';

/** Small deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type AnyPage = Page | LegacyPage;

/** One edit, applied the same way to either implementation. */
type Op = (p: AnyPage) => void;

interface Pair {
  now: Page;
  old: LegacyPage;
}

function pair(client: number): Pair {
  const a = new Y.Doc();
  const b = new Y.Doc();
  a.clientID = client;
  b.clientID = client;
  return { now: new Page(a), old: new LegacyPage(b) };
}

const READING = new Set(['text', 'textSrc', 'conf']);
const noReading = (o: object) => Object.fromEntries(Object.entries(o).filter(([k]) => !READING.has(k)));

/** Everything line assignment decides, plus the raw doc state it wrote (without lines' readings). */
function state(p: AnyPage): unknown {
  const d = p.doc;
  return {
    lines: p.lines().map(noReading),
    ids: p.items().map((i) => i.id),
    items: Object.fromEntries([...d.getMap<Y.Map<unknown>>('items').entries()].map(([id, m]) => [id, m.get('line') ?? null])),
    entries: Object.fromEntries(Object.entries(d.getMap('lines').toJSON()).map(([k, v]) => [k, noReading(v as object)])),
    order: d.getArray('order').toArray(),
  };
}

/** Keys passed to `setLineText` by the ops of the current batch. */
let textSet = new Set<string>();

/**
 * The reading rule, from the lines before a batch to after it: a line with a reading has the same items and reading
 * as before (or a user's reading, or one saved during the batch); and if the batch was one transaction, a line whose
 * items are the same as before kept its reading.
 */
function checkReadings(before: Line[], after: Line[], oneTx: boolean, what: string): void {
  const prev = new Map(before.map((l) => [l.key, l]));
  for (const l of after) {
    if (textSet.has(l.key)) continue;
    const b = prev.get(l.key);
    const same = !!b && b.itemIds.length === l.itemIds.length && b.itemIds.every((id) => l.itemIds.includes(id));
    if (l.text !== undefined && l.textSrc !== 'user') expect(same && b!.text === l.text && b!.textSrc === l.textSrc, `${what}: ${l.key} kept a reading of other items`).toBe(true);
    if (oneTx && same && b!.text !== undefined) expect([l.text, l.textSrc, l.conf], `${what}: ${l.key} lost its reading`).toEqual([b!.text, b!.textSrc, b!.conf]);
  }
}

function expectSame(p: Pair, what: string): void {
  expect(state(p.now), what).toEqual(state(p.old));
}

/** Random edits on a page of handwriting-like rows, with drawings, shapes and text mixed in. */
function randomOps(r: () => number, prefix: string, live: () => Item[]): Op[] {
  let n = 0;
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const subset = (): Item[] => {
    const items = live();
    if (!items.length) return [];
    // A band of rows (like a lasso), or a random sprinkle.
    if (r() < 0.6) {
      const y0 = r() * 700;
      const y1 = y0 + 30 + r() * 300;
      return items.filter((it) => {
        const b = it.type === 'stroke' ? it.bbox : it.type === 'text' ? [0, it.y, 0, it.y + 10] : it.type === 'shape' ? [0, it.pts[0]![1], 0, it.pts[0]![1]] : [0, 0, 0, 0];
        return b[1]! >= y0 && b[1]! <= y1;
      });
    }
    return items.filter(() => r() < 0.3);
  };
  const newStroke = (): StrokeItem => {
    const row = Math.floor(r() * 24);
    const x = 30 + r() * 480;
    const y = 40 + row * 30 + r() * 6;
    const tall = r() < 0.06;
    const h = tall ? 70 + r() * 120 : 8 + r() * 16;
    const w = 4 + r() * (tall ? 120 : 30);
    return stroke(`${prefix}s${n++}`, x, y, x + w, y + h);
  };
  const newShape = (): ShapeItem => {
    const x = 30 + r() * 400;
    const y = 40 + r() * 600;
    const w = 20 + r() * 150;
    const h = 20 + r() * 150;
    return { id: `${prefix}h${n++}`, type: 'shape', kind: pick(['rect', 'ellipse', 'line'] as const), pts: [[x, y], [x + w, y + h]], color: '#000', width: 2 };
  };
  const newText = (): TextItem => ({ id: `${prefix}t${n++}`, type: 'text', x: r() * 400, y: r() * 700, w: 120, text: 'hi', fontSize: 14, color: '#000' });
  const sim = (): Sim =>
    r() < 0.5
      ? { s: 1, r: 0, ox: 0, oy: 0, dx: (r() - 0.5) * 200, dy: (r() - 0.5) * 300 }
      : { s: 0.6 + r() * 0.9, r: (r() - 0.5) * 0.8, ox: r() * 500, oy: r() * 700, dx: (r() - 0.5) * 60, dy: (r() - 0.5) * 60 };

  const ops: Op[] = [];
  for (let i = 0; i < 60; i++) {
    const kind = r();
    if (kind < 0.3) {
      const items = Array.from({ length: 1 + Math.floor(r() * 40) }, () => (r() < 0.9 ? newStroke() : r() < 0.5 ? newShape() : newText()));
      ops.push((p) => items.forEach((it) => p.addItem(it)));
    } else if (kind < 0.55) {
      // Move / resize / rotate a selection (the patch is computed from each page's own current item).
      const s = sim();
      let ids: string[] | null = null;
      ops.push((p) => {
        ids ??= subset().map((it) => it.id);
        for (const id of ids) {
          const it = p.item(id);
          if (it) p.updateItem(id, transformPatch(it, s));
        }
      });
    } else if (kind < 0.63) {
      // Recolour; for shapes also a width (not a geometry key, but it changes the bbox).
      let ids: string[] | null = null;
      const w = 1 + r() * 8;
      ops.push((p) => {
        ids ??= subset().map((it) => it.id);
        for (const id of ids) p.updateItem(id, (p.item(id)?.type === 'shape' ? { color: '#b91c1c', width: w } : { color: '#b91c1c' }) as Partial<Item>);
      });
    } else if (kind < 0.75) {
      let ids: string[] | null = null;
      const oneByOne = r() < 0.5; // the eraser removes strokes one by one
      ops.push((p) => {
        ids ??= subset().map((it) => it.id);
        if (oneByOne) ids.forEach((id) => p.removeItems([id]));
        else p.removeItems(ids);
      });
    } else if (kind < 0.8) {
      let ids: string[] | null = null;
      const to = r() < 0.5 ? 'front' : 'back';
      ops.push((p) => {
        ids ??= subset().map((it) => it.id);
        p.reorder(ids, to);
      });
    } else if (kind < 0.88) {
      const src = pick(['device', 'agent', 'user'] as TextSrc[]);
      const k = r();
      ops.push((p) => {
        const lines = p.lines();
        if (!lines.length) return;
        const key = lines[Math.floor(k * lines.length)]!.key;
        textSet.add(key);
        p.setLineText(key, 'x²', src, 0.5);
      });
    } else if (kind < 0.93) {
      // Re-add a removed id, or replace an existing one (both keep the id's old z slot or reuse it).
      const s = newStroke();
      const k = r();
      ops.push((p) => {
        const items = p.items();
        const id = items.length && k < 0.5 ? items[Math.floor(k * 2 * items.length)]!.id : `${prefix}s${Math.floor(k * n)}`;
        p.addItem({ ...s, id });
      });
    } else {
      ops.push((p) => void p.lines()); // a read mid-transaction
    }
  }
  return ops;
}

/** Runs ops on both pages: some alone, some batched into one local transaction. */
function run(p: Pair, ops: Op[], r: () => number, label: string): void {
  let i = 0;
  while (i < ops.length) {
    const k = r() < 0.4 ? 1 : 1 + Math.floor(r() * 5);
    const batch = ops.slice(i, i + k);
    const before = p.now.lines();
    textSet = new Set();
    for (const page of [p.now, p.old]) {
      if (k === 1) batch[0]!(page);
      else page.doc.transact(() => batch.forEach((op) => op(page)), LOCAL_ORIGIN);
    }
    i += k;
    expectSame(p, `${label}, after op ${i}`);
    checkReadings(before, p.now.lines(), k > 1, `${label}, after op ${i}`);
  }
}

describe('bulk edits match per-item line assignment', () => {
  for (let seed = 1; seed <= 40; seed++) {
    it(`random edits, seed ${seed}`, () => {
      const p = pair(1);
      const r = rng(seed);
      const ops = randomOps(r, '', () => p.now.items());
      run(p, ops, r, `seed ${seed}`);
      expect(p.now.lines().length).toBeGreaterThan(0);
    });
  }

  it('moving whole lines keeps their keys, in one transaction', () => {
    const p = pair(1);
    for (const page of [p.now, p.old]) {
      for (let row = 0; row < 20; row++) for (let i = 0; i < 8; i++) page.addItem(stroke(`r${row}-${i}`, 40 + i * 14, 50 + row * 30, 50 + i * 14, 66 + row * 30));
    }
    const before = p.now.lines().map((l) => [l.key, l.itemIds]);
    p.now.updateItems(p.now.items().map((it) => [it.id, transformPatch(it, { s: 1, r: 0, ox: 0, oy: 0, dx: 37, dy: 211 })] as const));
    p.old.doc.transact(() => p.old.items().forEach((it) => p.old.updateItem(it.id, transformPatch(it, { s: 1, r: 0, ox: 0, oy: 0, dx: 37, dy: 211 }))), LOCAL_ORIGIN);
    expectSame(p, 'moved');
    expect(p.now.lines().map((l) => [l.key, l.itemIds])).toEqual(before);
  });

  it('addItems and updateItems equal addItem and updateItem in one transaction', () => {
    const p = pair(1);
    const r = rng(99);
    const items = Array.from({ length: 300 }, (_, i) => {
      const x = 30 + r() * 480;
      const y = 40 + Math.floor(r() * 24) * 30;
      return stroke(`s${i}`, x, y, x + 10, y + 14);
    });
    p.now.addItems(items);
    p.old.doc.transact(() => items.forEach((it) => p.old.addItem(it)), LOCAL_ORIGIN);
    expectSame(p, 'added');
    const s: Sim = { s: 1.2, r: 0.1, ox: 200, oy: 300, dx: 10, dy: -40 };
    const half = p.now.items().filter((_, i) => i % 2 === 0);
    p.now.updateItems(new Map(half.map((it) => [it.id, transformPatch(it, s)])));
    p.old.doc.transact(() => half.forEach((it) => p.old.updateItem(it.id, transformPatch(p.old.item(it.id)!, s))), LOCAL_ORIGIN);
    expectSame(p, 'updated');
  });

  it('copyFrom (page duplicate) then edits', () => {
    const src = pair(1);
    const r = rng(7);
    run(src, randomOps(r, '', () => src.now.items()).slice(0, 20), r, 'src');
    const dst = pair(2);
    let n = 0;
    let m = 0;
    dst.now.copyFrom(src.now, () => `n${n++}`);
    dst.old.copyFrom(src.old, () => `n${m++}`);
    expectSame(dst, 'copied');
    run(dst, randomOps(rng(8), 'd', () => dst.now.items()), rng(9), 'dst');
  });
});

describe('bulk edits: undo and sync', () => {
  it('a bulk move is one undo step, and undo/redo restore the same lines', () => {
    const p = pair(1);
    const undoNow = new Y.UndoManager([p.now.doc.getMap('items'), p.now.doc.getArray('order'), p.now.doc.getMap('lines')], { trackedOrigins: new Set([LOCAL_ORIGIN]), captureTimeout: 0 });
    const undoOld = new Y.UndoManager([p.old.doc.getMap('items'), p.old.doc.getArray('order'), p.old.doc.getMap('lines')], { trackedOrigins: new Set([LOCAL_ORIGIN]), captureTimeout: 0 });
    const r = rng(3);
    const items = Array.from({ length: 400 }, (_, i) => {
      const x = 30 + r() * 480;
      const y = 40 + Math.floor(r() * 24) * 30;
      return stroke(`s${i}`, x, y, x + 10, y + 14);
    });
    p.now.addItems(items);
    p.old.doc.transact(() => items.forEach((it) => p.old.addItem(it)), LOCAL_ORIGIN);
    const added = p.now.lines();
    for (const s of [
      { s: 1, r: 0, ox: 0, oy: 0, dx: 0, dy: 160 },
      { s: 0.7, r: 0.3, ox: 100, oy: 100, dx: 0, dy: 0 },
    ]) {
      p.now.updateItems(p.now.items().map((it) => [it.id, transformPatch(it, s)] as const));
      p.old.doc.transact(() => p.old.items().forEach((it) => p.old.updateItem(it.id, transformPatch(it, s))), LOCAL_ORIGIN);
      expectSame(p, 'moved');
    }
    const moved = p.now.lines();
    expect(undoNow.undoStack.length).toBe(3);
    undoNow.undo();
    undoOld.undo();
    expectSame(p, 'undo 1');
    undoNow.undo();
    undoOld.undo();
    expectSame(p, 'undo 2');
    // Same lines and keys (Yjs undo may leave or drop empty line entries; the old code did the same, checked above).
    expect(p.now.lines()).toEqual(added);
    undoNow.redo();
    undoOld.redo();
    undoNow.redo();
    undoOld.redo();
    expectSame(p, 'redo');
    expect(p.now.lines()).toEqual(moved);
    // Edits after undo/redo (the index must have been rebuilt from the restored doc).
    const r2 = rng(4);
    run(p, randomOps(r2, 'u', () => p.now.items()).slice(0, 30), r2, 'after redo');
  });

  it('two devices: concurrent bulk edits converge to the same state as the old code', () => {
    const a = pair(1);
    const b = pair(2);
    const syncPair = (x: AnyPage, y: AnyPage) => {
      Y.applyUpdate(y.doc, Y.encodeStateAsUpdate(x.doc, Y.encodeStateVector(y.doc)), 'remote');
      Y.applyUpdate(x.doc, Y.encodeStateAsUpdate(y.doc, Y.encodeStateVector(x.doc)), 'remote');
    };
    const ra = rng(11);
    const rb = rng(12);
    const opsA = randomOps(ra, 'a', () => a.now.items());
    const opsB = randomOps(rb, 'b', () => b.now.items());
    for (let round = 0; round < 6; round++) {
      run(a, opsA.slice(round * 10, round * 10 + 10), ra, `A round ${round}`);
      run(b, opsB.slice(round * 10, round * 10 + 10), rb, `B round ${round}`);
      syncPair(a.now, b.now);
      syncPair(a.old, b.old);
      expectSame(a, `A synced ${round}`);
      expectSame(b, `B synced ${round}`);
      expect(state(a.now)).toEqual(state(b.now));
    }
  });

  it('a remote update between two local edits is seen (the index is rebuilt)', () => {
    const local = new Page(new Y.Doc());
    const remote = new Page(new Y.Doc());
    local.addItem(stroke('a', 50, 100, 60, 120));
    Y.applyUpdate(remote.doc, Y.encodeStateAsUpdate(local.doc));
    remote.addItem(stroke('far', 300, 400, 310, 420));
    remote.updateItem('a', { bbox: [300, 400, 310, 420], points: pts([300, 400], [310, 420]) } as Partial<StrokeItem>);
    Y.applyUpdate(local.doc, Y.encodeStateAsUpdate(remote.doc, Y.encodeStateVector(local.doc)), 'remote');
    local.addItem(stroke('b', 62, 100, 70, 120)); // a moved away: b starts its own line
    expect(local.lines().map((l: Line) => [l.key, l.itemIds])).toEqual([
      ['a', ['a', 'far']],
      ['b', ['b']],
    ]);
  });

  it('raw writes mixed with Page calls (one transaction or between) are seen', () => {
    const p = pair(1);
    for (const page of [p.now, p.old]) {
      page.addItem(stroke('a', 50, 100, 60, 120));
      page.addItem(stroke('b', 62, 100, 70, 120));
      page.addItem(stroke('z', 50, 300, 60, 320));
    }
    expectSame(p, 'setup');
    // Raw edits of the line fields and items, inside one transaction with Page calls before and after.
    for (const page of [p.now, p.old]) {
      const d = page.doc;
      const items = d.getMap<Y.Map<unknown>>('items');
      d.transact(() => {
        page.addItem(stroke('c', 72, 100, 80, 120));
        void page.lines();
        items.get('b')!.set('line', 'z'); // b now claims z's line
        items.get('c')!.delete('line');
        page.addItem(stroke('y', 62, 300, 70, 320));
        void page.lines();
        items.get('z')!.set('bbox', [50, 500, 60, 520]); // moved without Page
        page.updateItem('y', { color: '#b91c1c' });
        page.updateItem('a', { bbox: [50, 300, 60, 320], points: pts([50, 300], [60, 320]) } as Partial<StrokeItem>);
      }, LOCAL_ORIGIN);
    }
    expectSame(p, 'mixed transaction');
    // Raw writes in their own transaction, then a Page read and edit.
    for (const page of [p.now, p.old]) {
      page.doc.getMap<Y.Map<unknown>>('items').get('a')!.set('line', 'b');
      page.addItem(stroke('w', 74, 300, 80, 320));
    }
    expectSame(p, 'raw transaction');
  });
});
