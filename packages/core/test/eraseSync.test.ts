// Partial erase writes once per gesture (review rounds of PR #68): an EraseSession keeps the gesture locally, and the
// pen-up commits it in one transaction (touched strokes deleted, their pieces added as new strokes with `splitFrom`).
// Nothing mid-gesture, doc growth, and two or three devices editing the same strokes.
import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { createUndoManager, decodePoints, EraseSession, moveBy, Page, type InkPoint, type Item, type StrokeItem } from '../src';
import { pointsBBox } from '../src/geometry/bbox';
import { handwriting } from './ink';

let n = 0;
const ids = () => `q${++n}`;

function line(id: string, x0: number, x1: number, y: number, step = 2): StrokeItem {
  const points: InkPoint[] = [];
  for (let x = x0, i = 0; x <= x1 + 1e-9; x += step, i++) points.push({ x, y, p: 0.2 + (0.6 * (x - x0)) / (x1 - x0), tilt: 1.2, az: 0.3, t: i * 4 });
  return { id, type: 'stroke', tool: 'pen', color: '#27272a', width: 2, points, bbox: pointsBBox(points, 1), createdAt: 5 };
}
const strokes = (p: Page) => p.items().filter((it): it is StrokeItem => it.type === 'stroke');
const len = (s: StrokeItem) => s.points.reduce((k, q, i) => (i ? k + Math.hypot(q.x - s.points[i - 1]!.x, q.y - s.points[i - 1]!.y) : 0), 0);
const inkLength = (p: Page) => strokes(p).reduce((k, s) => k + len(s), 0);
const xs = (s: StrokeItem) => [Math.round(Math.min(...s.points.map((q) => q.x))), Math.round(Math.max(...s.points.map((q) => q.x)))];
const spans = (p: Page) => strokes(p).map(xs).sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!);

/** One eraser gesture: each segment applied locally, committed once at the end (what the editor does at pen-up). */
function gesture(page: Page, segments: { x: number; y: number }[][], r: number) {
  const s = new EraseSession(ids);
  for (const seg of segments) s.apply(page.items(), seg, r);
  page.applyErase(s.commitPlan(page.items()));
}
const at = (x: number, y = 50) => [{ x, y }];

/** Devices with the same page, synced by `sync()` (every pair, both ways, like the server relaying updates). */
function devices(count: number, setup: (p: Page) => void) {
  const docs = [new Y.Doc()];
  setup(new Page(docs[0]!));
  for (let i = 1; i < count; i++) {
    const d = new Y.Doc();
    Y.applyUpdate(d, Y.encodeStateAsUpdate(docs[0]!));
    docs.push(d);
  }
  const pages = docs.map((d) => new Page(d));
  const sync = () => {
    for (const a of docs) for (const b of docs) if (a !== b) Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  };
  return { pages, sync };
}

describe('a partial-erase gesture', () => {
  it('writes nothing while the eraser is down: the session holds what the page would look like', () => {
    const page = new Page(new Y.Doc());
    page.addItem(line('s', 0, 100, 50));
    const before = Y.encodeStateAsUpdate(page.doc);
    const s = new EraseSession(ids);
    expect(s.apply(page.items(), at(30), 3)).toBe(true);
    expect(s.apply(page.items(), at(70), 3)).toBe(true);
    expect(Y.encodeStateAsUpdate(page.doc)).toEqual(before); // an app killed now leaves the page as it was
    const view = s.view(page.items()) as StrokeItem[];
    expect(view.map(xs)).toEqual([[0, 26], [34, 66], [74, 100]]);
    expect(view.every((p) => p.splitFrom === 's' && p.id !== 's')).toBe(true);
  });

  it('commits once, in one undo step: the stroke deleted, its pieces added (in its z-order slot)', () => {
    const page = new Page(new Y.Doc());
    page.addItems([line('below', 0, 10, 10), line('s', 0, 100, 50), line('above', 0, 10, 90)]);
    const um = createUndoManager(page);
    const s = new EraseSession(ids);
    for (const x of [30, 31, 32, 70]) s.apply(page.items(), at(x), 3);
    page.applyErase(s.commitPlan(page.items()));
    expect(um.undoStack).toHaveLength(1);
    expect(page.items().map((it) => it.id)[0]).toBe('below');
    expect(page.items().map((it) => it.id).at(-1)).toBe('above');
    expect(spans(page)).toEqual([[0, 10], [0, 10], [0, 26], [36, 66], [74, 100]]);
    um.undo();
    expect(page.items().map((it) => it.id)).toEqual(['below', 's', 'above']);
    um.redo();
    expect(page.item('s')).toBeUndefined();
  });

  it('one 50-move rub along a 1000-point stroke grows the doc by one rewrite of what is left', () => {
    const page = new Page(new Y.Doc());
    page.addItem(line('s', 0, 1999, 50)); // 1000 points
    createUndoManager(page);
    const before = Y.encodeStateAsUpdate(page.doc).length;
    gesture(page, Array.from({ length: 50 }, (_, i) => [{ x: 2000 - i * 20, y: 50 }, { x: 1990 - i * 20, y: 50 }]), 6);
    const grew = Y.encodeStateAsUpdate(page.doc).length - before;
    expect(strokes(page)).toHaveLength(1);
    expect(strokes(page)[0]!.points.length).toBeGreaterThan(450);
    // ~0.9 MB when every move re-created the pieces; one commit writes the ~500 points left once.
    expect(grew).toBeLessThan(20_000);
  });

  it('stays quick on a dense page (3000 strokes): a move of the eraser, preview included, well under 2.3 ms', () => {
    const page = new Page(new Y.Doc());
    const items: Item[] = [];
    for (let r = 0; r < 50; r++) for (let c = 0; c < 10; c++) items.push(...handwriting(`d${r}_${c}_`, 'cos(x)', 20 + c * 56, 20 + r * 16, 9));
    page.addItems(items);
    expect(page.items().length).toBeGreaterThan(3000);
    const batch = () => {
      const s = new EraseSession(ids);
      const t0 = Date.now();
      for (let i = 0; i < 40; i++) {
        s.apply(page.items(), [{ x: 100 + i * 2, y: 200 }, { x: 102 + i * 2, y: 201 }], 6);
        s.view(page.items());
      }
      return (Date.now() - t0) / 40;
    };
    batch();
    expect(Math.min(batch(), batch(), batch())).toBeLessThan(2.3);
  });

  it('a reader that ignores splitFrom sees plain strokes: points and box as drawn', () => {
    const page = new Page(new Y.Doc());
    page.addItem(line('s', 0, 100, 50));
    gesture(page, [at(50)], 5);
    const raw = page.doc.getMap<Y.Map<unknown>>('items');
    for (const s of strokes(page)) {
      const m = raw.get(s.id)!;
      expect([...m.keys()].sort()).toEqual(['bbox', 'color', 'createdAt', 'id', 'points', 'splitFrom', 'tool', 'type', 'width']);
      expect(decodePoints(m.get('points') as Uint8Array).map((q) => q.x)).toEqual(s.points.map((q) => q.x));
      expect(m.get('bbox')).toEqual(pointsBBox(s.points, 1));
    }
  });
});

describe('two or three devices', () => {
  it('erase, a move of the stroke elsewhere, then undo: the stroke comes back whole (the move is lost)', () => {
    const { pages: [a, b], sync } = devices(2, (p) => p.addItem(line('s', 0, 100, 50)));
    const um = createUndoManager(a!);
    gesture(a!, [at(60)], 3);
    b!.transformItems(['s'], moveBy(0, 30)); // before B has seen the erase
    sync();
    um.undo();
    sync();
    for (const p of [a!, b!]) {
      expect(spans(p)).toEqual([[0, 100]]);
      expect(inkLength(p)).toBeCloseTo(100, 6); // nothing lost, nothing twice
    }
  });

  it('erase, a move of one piece elsewhere, then undo: the pieces go and the stroke comes back', () => {
    const { pages: [a, b], sync } = devices(2, (p) => p.addItem(line('s', 0, 100, 50)));
    const um = createUndoManager(a!);
    gesture(a!, [at(60)], 3);
    sync();
    b!.transformItems([strokes(b!)[0]!.id], moveBy(0, 30));
    sync();
    um.undo();
    sync();
    for (const p of [a!, b!]) expect(strokes(p).map((s) => s.id)).toEqual(['s']);
  });

  it('erasing opposite ends at once: both apply, and each side keeps its own piece of the middle (the documented overlap)', () => {
    const { pages: [a, b], sync } = devices(2, (p) => p.addItem(line('s', 0, 100, 50)));
    gesture(a!, [at(30)], 3);
    gesture(b!, [at(70)], 3);
    sync();
    expect(spans(a!)).toEqual(spans(b!));
    expect(a!.item('s')).toBeUndefined();
    // A's pieces 0..26 and 34..100, B's 0..66 and 74..100: 34..66 shows twice, the erased spots each show the other
    // side's ink. Rare (one person, two devices, one stroke, the same moment); never lost.
    expect(spans(a!)).toEqual([[0, 26], [0, 66], [34, 100], [74, 100]]);
  });

  it('erasing the same spot at once: the pieces show twice, nothing is lost', () => {
    const { pages: [a, b], sync } = devices(2, (p) => p.addItem(line('s', 0, 100, 50)));
    gesture(a!, [at(30)], 3);
    gesture(b!, [at(30)], 3);
    sync();
    expect(spans(a!)).toEqual([[0, 26], [0, 26], [34, 100], [34, 100]]);
    expect(spans(b!)).toEqual(spans(a!));
  });

  it('one deletes the stroke while the other erases part of it: it stays deleted (the other\'s pieces remain)', () => {
    const { pages: [a, b], sync } = devices(2, (p) => p.addItem(line('s', 0, 100, 50)));
    a!.removeItems(['s']);
    gesture(b!, [at(30)], 3);
    sync();
    for (const p of [a!, b!]) {
      expect(p.item('s')).toBeUndefined();
      expect(strokes(p).every((s) => s.splitFrom === 's')).toBe(true);
    }
  });

  it('undo and redo with another device editing in between keep both', () => {
    const { pages: [a, b], sync } = devices(2, (p) => p.addItem(line('s', 0, 100, 50)));
    const um = createUndoManager(a!);
    gesture(a!, [at(50)], 5);
    sync();
    b!.addItem(line('t', 0, 100, 80));
    sync();
    um.undo();
    sync();
    for (const p of [a!, b!]) expect(strokes(p).map((s) => s.id).sort()).toEqual(['s', 't']);
    um.redo();
    sync();
    for (const p of [a!, b!]) {
      expect(p.item('s')).toBeUndefined();
      expect(p.item('t')).toBeDefined();
      expect(strokes(p)).toHaveLength(3);
    }
  });

  it('three devices (erase, move, erase of another stroke) end up the same', () => {
    const { pages, sync } = devices(3, (p) => p.addItems([line('s', 0, 100, 50), line('u', 0, 100, 90)]));
    const [a, b, c] = pages as [Page, Page, Page];
    gesture(a, [at(40)], 3);
    b.transformItems(['s'], moveBy(5, 0));
    gesture(c, [at(60, 90)], 3);
    sync();
    const shape = (p: Page) => JSON.stringify(spans(p));
    expect(shape(b)).toEqual(shape(a));
    expect(shape(c)).toEqual(shape(a));
    expect(a.item('s')).toBeUndefined();
    expect(a.item('u')).toBeUndefined();
    const items: Item[] = a.items();
    expect(items.every((it) => it.type !== 'stroke' || it.splitFrom === 's' || it.splitFrom === 'u')).toBe(true);
  });
});
