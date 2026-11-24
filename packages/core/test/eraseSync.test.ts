// Partial erase keeps the stroke's id for its longest piece: a cut (`cutFrom` / `cutTo`) while the eraser is down,
// baked into real points when the gesture ends. Doc growth, moves of a cut stroke, two devices editing one stroke,
// what a reader without cuts sees, and undo across the bake (reviews of PR #68).
import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { createUndoManager, decodePoints, moveBy, Page, planPartialErase, type InkPoint, type StrokeItem } from '../src';
import { pointsBBox } from '../src/geometry/bbox';

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
const xs = (s: StrokeItem) => [Math.min(...s.points.map((q) => q.x)), Math.max(...s.points.map((q) => q.x))];
/** One eraser segment; returns the ids of strokes it cut (to bake at the end of the gesture). */
const erase = (p: Page, path: { x: number; y: number }[], r: number) => {
  const plan = planPartialErase(p.items(), path, r, ids);
  p.applyErase(plan);
  return plan.split.filter((s) => s.keep).map((s) => s.id);
};
/** What a build without cuts reads: the stored points and box as they are. */
const raw = (p: Page, id: string) => {
  const m = p.doc.getMap<Y.Map<unknown>>('items').get(id)!;
  return { points: decodePoints(m.get('points') as Uint8Array), bbox: m.get('bbox') as number[], cut: m.has('cutFrom') || m.has('cutTo') };
};

/** Two devices with the same page: `a` and `b`, synced by `sync()` (both ways, like the server relaying updates). */
function pair(setup: (p: Page) => void) {
  const da = new Y.Doc();
  const a = new Page(da);
  setup(a);
  const db = new Y.Doc();
  Y.applyUpdate(db, Y.encodeStateAsUpdate(da));
  const b = new Page(db);
  const sync = () => {
    const ua = Y.encodeStateAsUpdate(da, Y.encodeStateVector(db));
    const ub = Y.encodeStateAsUpdate(db, Y.encodeStateVector(da));
    Y.applyUpdate(db, ua);
    Y.applyUpdate(da, ub);
  };
  return { a, b, sync };
}

describe('partial erase keeps the stroke id', () => {
  it('rubbing along a long stroke updates one item; the doc hardly grows, bake included (with undo history)', () => {
    const page = new Page(new Y.Doc());
    page.addItem(line('s', 0, 1999, 50)); // 1000 points
    const um = createUndoManager(page);
    const before = Y.encodeStateAsUpdate(page.doc).length;
    // One gesture: 50 pointer moves rubbing in from the right end, then the bake when the pen lifts.
    const cut = new Set<string>();
    for (let i = 0; i < 50; i++) for (const id of erase(page, [{ x: 2000 - i * 20, y: 50 }, { x: 1990 - i * 20, y: 50 }], 6)) cut.add(id);
    const during = Y.encodeStateAsUpdate(page.doc).length;
    page.bakeCuts(cut);
    const after = Y.encodeStateAsUpdate(page.doc).length;
    expect(strokes(page).map((s) => s.id)).toEqual(['s']);
    expect(Math.max(...strokes(page)[0]!.points.map((q) => q.x))).toBeCloseTo(2000 - 49 * 20 - 10 - 6 - 1, 0);
    // Re-creating the pieces on every move grew it by ~907 KB; the cuts take a few KB, the bake one write of the
    // kept points (~500 here).
    expect(during - before).toBeLessThan(8_000);
    expect(after - before).toBeLessThan(40_000);
    expect(raw(page, 's').cut).toBe(false);
    while (um.undoStack.length) um.undo();
    expect(strokes(page)[0]!.points).toHaveLength(1000);
  });

  it('a cut of a cut reads as the same points the eraser planned', () => {
    const page = new Page(new Y.Doc());
    page.addItem(line('s', 0, 200, 50));
    erase(page, [{ x: 200, y: 50 }], 10); // shortens the right end
    const plan = planPartialErase(page.items(), [{ x: 30, y: 50 }], 5, ids); // then a gap near the left
    const kept = plan.split[0]!.pieces.find((p) => p.id === 's')!;
    page.applyErase(plan);
    const now = page.item('s') as StrokeItem;
    expect(now.points).toHaveLength(kept.points.length);
    now.points.forEach((q, i) => {
      expect(q.x).toBeCloseTo(kept.points[i]!.x, 3);
      expect(q.p).toBeCloseTo(kept.points[i]!.p, 3);
    });
    expect(now.bbox).toEqual(pointsBBox(now.points, 1));
    expect(strokes(page).find((s) => s.id !== 's')!.splitFrom).toBe('s');
  });

  it('a piece split again still names the stroke as drawn', () => {
    const page = new Page(new Y.Doc());
    page.addItem(line('s', 0, 300, 50));
    erase(page, [{ x: 200, y: 50 }], 5);
    const piece = strokes(page).find((s) => s.id !== 's')!;
    erase(page, [{ x: 260, y: 50 }], 5);
    const kids = strokes(page).filter((s) => s.id !== 's' && s.id !== piece.id);
    expect(kids).toHaveLength(1);
    expect(kids[0]!.splitFrom).toBe('s');
  });
});

describe('baking a cut at the end of the gesture', () => {
  it('writes the kept points once: a reader without cuts sees the right ink and box', () => {
    const page = new Page(new Y.Doc());
    page.addItem(line('s', 0, 200, 50));
    const cut = erase(page, [{ x: 0, y: 50 }], 10); // rubs the left end: 's' keeps ~11..200
    expect(raw(page, 's').cut).toBe(true);
    expect(raw(page, 's').points).toHaveLength(101); // still the stored points: an old build would draw them all
    page.bakeCuts(cut);
    const r = raw(page, 's');
    const s = page.item('s') as StrokeItem;
    expect(r.cut).toBe(false);
    expect(r.points.map((q) => q.x)).toEqual(s.points.map((q) => q.x));
    expect(r.bbox).toEqual(s.bbox);
    expect(xs(s)[0]).toBeCloseTo(11, 0);
  });

  it('one undo of the gesture (cuts and bake) brings the stroke back whole; redo bakes it again', () => {
    const page = new Page(new Y.Doc());
    page.addItem(line('s', 0, 200, 50));
    const um = createUndoManager(page);
    const steps0 = um.undoStack.length;
    const cut = new Set([...erase(page, [{ x: 0, y: 50 }], 10), ...erase(page, [{ x: 100, y: 50 }], 5)]);
    page.bakeCuts(cut);
    const baked = strokes(page).map((s) => [s.id, ...xs(s).map((v) => Math.round(v))]);
    const steps = um.undoStack.length - steps0;
    for (let i = 0; i < steps; i++) um.undo();
    expect(strokes(page).map((s) => s.id)).toEqual(['s']);
    expect(raw(page, 's').points).toHaveLength(101);
    expect(raw(page, 's').cut).toBe(false);
    for (let i = 0; i < steps; i++) um.redo();
    expect(strokes(page).map((s) => [s.id, ...xs(s).map((v) => Math.round(v))])).toEqual(baked);
    expect(raw(page, 's').cut).toBe(false);
  });

  it('a cut end written against points another device has since replaced (baked) is ignored, never misapplied', () => {
    const { a, b, sync } = pair((p) => p.addItem(line('s', 0, 100, 50)));
    a.bakeCuts(erase(a, [{ x: 0, y: 50 }], 10)); // A rubs the left end and lifts: 's' is ~11..100, baked
    erase(b, [{ x: 100, y: 50 }], 10); // B, at the same time, rubs the right end of the old points (cutTo ~89)
    sync();
    for (const p of [a, b]) {
      const s = p.item('s') as StrokeItem;
      // A's bake stands (B's end indexes the old points): B's rub of that end is lost, but no ink is wrongly cut.
      expect(xs(s)[0]).toBeCloseTo(11, 0);
      expect(xs(s)[1]).toBeCloseTo(100, 0);
    }
  });
});

describe('moving a cut stroke', () => {
  it('moves what is left of it, and the cut stays on the same ink', () => {
    const page = new Page(new Y.Doc());
    page.addItem(line('s', 0, 100, 50));
    erase(page, [{ x: 100, y: 50 }], 10);
    const before = page.item('s') as StrokeItem;
    page.transformItems(['s'], moveBy(0, 30));
    const now = page.item('s') as StrokeItem;
    expect(now.points).toHaveLength(before.points.length);
    expect(xs(now)).toEqual(xs(before));
    expect(now.points.every((q) => q.y === 80)).toBe(true);
    expect(raw(page, 's').cut).toBe(true); // still the gesture's cut, on the moved points
  });
});

describe('two devices, the same stroke', () => {
  it('both split it while their erasers are down: both erases apply (34..66 kept, plus both pieces)', () => {
    const { a, b, sync } = pair((p) => p.addItem(line('s', 0, 100, 50)));
    erase(a, [{ x: 30, y: 50 }], 3); // 's' keeps 34..100 (the longest), a new piece 0..26
    erase(b, [{ x: 70, y: 50 }], 3); // 's' keeps 0..66, a new piece 74..100
    sync();
    for (const p of [a, b]) {
      const s = p.item('s') as StrokeItem;
      expect(xs(s)[0]).toBeCloseTo(34, 0);
      expect(xs(s)[1]).toBeCloseTo(66, 0);
      const pieces = strokes(p).filter((x) => x.id !== 's').map((x) => xs(x).map((v) => Math.round(v)));
      expect(pieces.sort((u, v) => u[0]! - v[0]!)).toEqual([
        [0, 26],
        [74, 100],
      ]);
    }
    expect(inkLength(a)).toBeCloseTo(26 + 32 + 26, 0);
  });

  it('one deletes it, the other splits it: it stays deleted (the piece split off before the delete arrived remains)', () => {
    const { a, b, sync } = pair((p) => p.addItem(line('s', 0, 100, 50)));
    a.removeItems(['s']);
    erase(b, [{ x: 30, y: 50 }], 3);
    sync();
    expect(a.item('s')).toBeUndefined();
    expect(b.item('s')).toBeUndefined();
    expect(strokes(a).every((s) => s.splitFrom === 's')).toBe(true);
    expect(inkLength(a)).toBeLessThan(35);
  });

  it('one moves it, the other splits it: both apply', () => {
    const { a, b, sync } = pair((p) => p.addItem(line('s', 0, 100, 50)));
    a.transformItems(['s'], moveBy(0, 30));
    erase(b, [{ x: 75, y: 50 }], 5); // 's' keeps 0..~69, a new piece ~81..100
    sync();
    for (const p of [a, b]) {
      const now = p.item('s') as StrokeItem;
      expect(now.points.every((q) => q.y === 80)).toBe(true);
      expect(xs(now)[1]).toBeCloseTo(69, 0);
      expect(now.bbox[1]).toBeCloseTo(79, 3);
    }
  });

  it('a stroke already cut, moved on one device while rubbed on the other: un-erased ink stays, both apply (review probe)', () => {
    // 0..200, already cut to 21..200 (shared); A moves it down 30 while B rubs at x = 150.
    const { a, b, sync } = pair((p) => {
      p.addItem(line('s', 0, 200, 50));
      erase(p, [{ x: 0, y: 50 }], 20);
    });
    expect(xs(a.item('s') as StrokeItem)[0]).toBeCloseTo(21, 0);
    a.transformItems(['s'], moveBy(0, 30));
    erase(b, [{ x: 150, y: 50 }], 3); // 's' keeps 21..146 (the longest), a new piece 154..200
    sync();
    for (const p of [a, b]) {
      const s = p.item('s') as StrokeItem;
      expect(xs(s)[0]).toBeCloseTo(21, 0);
      expect(xs(s)[1]).toBeCloseTo(146, 0);
      expect(s.points.every((q) => q.y === 80)).toBe(true);
    }
  });

  it('after a move from another device, undoing an erase still brings the ink back', () => {
    const { a, b, sync } = pair((p) => p.addItem(line('s', 0, 100, 50)));
    const um = createUndoManager(b);
    erase(b, [{ x: 100, y: 50 }], 10); // B shortens it to ~0..89
    sync();
    a.transformItems(['s'], moveBy(0, 30));
    sync();
    um.undo();
    sync();
    for (const p of [a, b]) {
      const s = p.item('s') as StrokeItem;
      expect(xs(s)[1]).toBeCloseTo(100, 0); // the erase is undone…
      expect(s.points.every((q) => q.y === 80)).toBe(true); // …and the move stays
    }
  });
});
