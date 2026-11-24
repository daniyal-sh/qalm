// Partial erase keeps the stroke's id for its longest piece (a `cut` of its stored points): doc growth while rubbing,
// cuts on cuts, moves after a cut, and two devices editing the same stroke at once (review of PR #68).
import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { createUndoManager, Page, planPartialErase, type InkPoint, type StrokeItem } from '../src';
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
const erase = (p: Page, path: { x: number; y: number }[], r: number) => p.applyErase(planPartialErase(p.items(), path, r, ids));

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
  it('rubbing along a long stroke updates one item, and the doc hardly grows (undo history included)', () => {
    const page = new Page(new Y.Doc());
    page.addItem(line('s', 0, 1999, 50)); // 1000 points
    const um = createUndoManager(page);
    const before = Y.encodeStateAsUpdate(page.doc).length;
    // One gesture: 50 pointer moves rubbing in from the right end.
    for (let i = 0; i < 50; i++) erase(page, [{ x: 2000 - i * 20, y: 50 }, { x: 1990 - i * 20, y: 50 }], 6);
    const after = Y.encodeStateAsUpdate(page.doc).length;
    expect(strokes(page).map((s) => s.id)).toEqual(['s']);
    expect(Math.max(...strokes(page)[0]!.points.map((q) => q.x))).toBeCloseTo(2000 - 49 * 20 - 10 - 6 - 1, 0);
    // Writing the 1000 points again on every move grew the doc by ~1.1 MB; a cut is a few dozen bytes per move.
    expect(after - before).toBeLessThan(8_000);
    expect(um.undoStack.length).toBeGreaterThan(0);
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
    const piece = strokes(page).find((s) => s.id !== 's')!;
    expect(piece.splitFrom).toBe('s');
  });

  it('a piece split again still names the stroke as drawn', () => {
    const page = new Page(new Y.Doc());
    page.addItem(line('s', 0, 300, 50));
    erase(page, [{ x: 200, y: 50 }], 5); // 's' keeps 0..~193, a new piece ~207..300
    const piece = strokes(page).find((s) => s.id !== 's')!;
    erase(page, [{ x: 260, y: 50 }], 5); // split that piece
    const kids = strokes(page).filter((s) => s.id !== 's' && s.id !== piece.id);
    expect(kids).toHaveLength(1);
    expect(kids[0]!.splitFrom).toBe('s');
  });

  it('moving a cut stroke moves what is left of it (the cut is done)', () => {
    const page = new Page(new Y.Doc());
    page.addItem(line('s', 0, 100, 50));
    erase(page, [{ x: 100, y: 50 }], 10);
    const s = page.item('s') as StrokeItem;
    const moved = s.points.map((q) => ({ ...q, y: q.y + 30 }));
    page.updateItem('s', { points: moved, bbox: pointsBBox(moved, 1) });
    const now = page.item('s') as StrokeItem;
    expect(now.points).toHaveLength(s.points.length);
    expect(Math.max(...now.points.map((q) => q.x))).toBeCloseTo(Math.max(...s.points.map((q) => q.x)), 3);
    expect(now.points.every((q) => q.y === 80)).toBe(true);
  });
});

describe('two devices, the same stroke', () => {
  it('both split it: the stroke is not brought back twice', () => {
    const { a, b, sync } = pair((p) => p.addItem(line('s', 0, 100, 50)));
    erase(a, [{ x: 30, y: 50 }], 3);
    erase(b, [{ x: 70, y: 50 }], 3);
    sync();
    expect(a.items().map((it) => it.id).sort()).toEqual(b.items().map((it) => it.id).sort());
    expect(strokes(a).filter((s) => s.id === 's')).toHaveLength(1);
    // Before: the whole stroke came back twice (four pieces, ~190 units of ink). Now one cut wins for 's' and each
    // device's new piece stays: at most a piece's worth of ink appears twice.
    expect(inkLength(a)).toBeLessThan(100 * 1.35);
    expect(inkLength(a)).toBeCloseTo(inkLength(b), 6);
  });

  it('one deletes it, the other splits it: it stays deleted (only the split-off piece can remain)', () => {
    const { a, b, sync } = pair((p) => p.addItem(line('s', 0, 100, 50)));
    a.removeItems(['s']);
    erase(b, [{ x: 30, y: 50 }], 3);
    sync();
    expect(a.item('s')).toBeUndefined();
    expect(b.item('s')).toBeUndefined();
    const left = strokes(a);
    expect(left.every((s) => s.splitFrom === 's')).toBe(true);
    expect(inkLength(a)).toBeLessThan(35);
  });

  it('one moves it, the other splits it: both apply to it', () => {
    const { a, b, sync } = pair((p) => p.addItem(line('s', 0, 100, 50)));
    const s = a.item('s') as StrokeItem;
    const moved = s.points.map((q) => ({ ...q, y: q.y + 30 }));
    a.updateItem('s', { points: moved, bbox: pointsBBox(moved, 1) });
    erase(b, [{ x: 75, y: 50 }], 5); // 's' keeps 0..~69 (the longest), a new piece ~81..100
    sync();
    for (const p of [a, b]) {
      const now = p.item('s') as StrokeItem;
      expect(now.points.every((q) => q.y === 80)).toBe(true); // moved…
      expect(Math.max(...now.points.map((q) => q.x))).toBeCloseTo(69, 0); // …and cut
      expect(now.bbox[1]).toBeCloseTo(79, 3);
    }
  });
});
