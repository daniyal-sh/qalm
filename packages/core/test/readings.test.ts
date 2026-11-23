// Readings: someone's reading of some strokes. A reading goes stale (kept, marked) when strokes are added to or erased
// from what it reads; moving, resizing or recolouring the read ink keeps it fresh.
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createUndoManager, freshCover, Page, transformPatch } from '../src';
import type { Sim } from '../src';
import { newPage, stroke, sync } from './helpers';

/** `x^2` on one row (a, b, c), `dx` far below (z, y). */
function twoRows(page = newPage()): Page {
  page.addItems([stroke('a', 50, 100, 60, 120), stroke('b', 62, 100, 70, 120), stroke('c', 72, 100, 80, 120), stroke('z', 50, 300, 60, 320), stroke('y', 62, 300, 70, 320)]);
  page.setReading(['a', 'b', 'c'], 'x^2', 'agent', 'Claude');
  page.setReading(['z', 'y'], 'dx', 'user');
  return page;
}

const move = (p: Page, ids: string[], f: Sim) => p.updateItems(ids.map((id) => [id, transformPatch(p.item(id)!, f)] as const));
const state = (p: Page) => p.readings().map((r) => [r.text, r.src, !!r.stale]).sort((a, b) => (a[0]! < b[0]! ? 1 : -1));
const reading = (p: Page, text: string) => p.readings().find((r) => r.text === text)!;

describe('readings', () => {
  it('saves readings with their strokes, source and agent name', () => {
    const page = twoRows();
    expect([...page.readings()].sort((a, b) => (a.text < b.text ? 1 : -1))).toMatchObject([
      { ids: ['a', 'b', 'c'], text: 'x^2', src: 'agent', by: 'Claude' },
      { ids: ['z', 'y'], text: 'dx', src: 'user' },
    ]);
  });

  it('an agent cannot read over the student; a new agent reading replaces the old one it covers', () => {
    const page = twoRows();
    expect(page.setReading(['y'], 'dy', 'agent', 'Claude')).toBeNull();
    page.addItem(stroke('d', 82, 100, 90, 120));
    expect(page.setReading(['a', 'b', 'c', 'd'], 'x^2+', 'agent', 'Claude')).toBeTruthy();
    expect(state(page)).toEqual([
      ['x^2+', 'agent', false],
      ['dx', 'user', false],
    ]);
    expect(page.setReading(['gone'], 'x', 'agent')).toBeNull();
  });

  it('moving, resizing or rotating the read ink (alone or with other read ink) keeps it fresh', () => {
    const page = twoRows();
    move(page, ['a', 'b', 'c'], { s: 1.5, r: 0.2, ox: 50, oy: 100, dx: 30, dy: 400 });
    move(page, ['a', 'b', 'c', 'z', 'y'], { s: 1, r: 0, ox: 0, oy: 0, dx: 5, dy: 5 });
    page.updateItem('a', { color: '#ff0000' });
    expect(state(page)).toEqual([
      ['x^2', 'agent', false],
      ['dx', 'user', false],
    ]);
  });

  it('goes stale when a stroke is written next to it or one of its strokes is erased; far ink does not count', () => {
    const page = twoRows();
    page.addItem(stroke('far', 300, 600, 310, 620));
    expect(state(page).map((x) => x[2])).toEqual([false, false]);
    page.addItem(stroke('sup', 82, 92, 86, 100)); // an exponent on x^2
    expect(state(page)).toEqual([
      ['x^2', 'agent', true],
      ['dx', 'user', false],
    ]);
    page.removeItems(['y']);
    expect(state(page)).toEqual([
      ['x^2', 'agent', true],
      ['dx', 'user', true],
    ]);
  });

  it('goes stale when ink is written on its row (like context: under 1½ units away), not on the row below', () => {
    const page = twoRows();
    page.addItem(stroke('below', 50, 160, 60, 180)); // 40 below x^2 (unit 30): another row
    expect(state(page)[0]).toEqual(['x^2', 'agent', false]);
    page.addItem(stroke('more', 100, 100, 110, 120)); // 20 to the right of c: same row, 2/3 unit
    expect(state(page)[0]).toEqual(['x^2', 'agent', true]);
  });

  it('goes stale when other ink is moved onto it, not when it is moved away', () => {
    const page = twoRows();
    page.addItem(stroke('w', 300, 100, 310, 120));
    move(page, ['w'], { s: 1, r: 0, ox: 0, oy: 0, dx: -215, dy: 0 }); // now right next to c
    expect(state(page)[0]).toEqual(['x^2', 'agent', true]);
  });

  it('is deleted when all of its strokes are erased, and undo brings it back fresh', () => {
    const page = twoRows();
    const um = createUndoManager(page);
    page.removeItems(['z', 'y']);
    expect(state(page)).toEqual([['x^2', 'agent', false]]);
    um.undo();
    expect(state(page)).toEqual([
      ['x^2', 'agent', false],
      ['dx', 'user', false],
    ]);
  });

  it('undo of the stroke that made it stale makes it fresh again', () => {
    const page = twoRows();
    const um = createUndoManager(page);
    page.addItem(stroke('sup', 82, 92, 86, 100));
    expect(reading(page, 'x^2').stale).toBe(true);
    um.undo();
    expect(reading(page, 'x^2').stale).toBeUndefined();
    um.redo();
    expect(reading(page, 'x^2').stale).toBe(true);
  });

  it("the student's edit makes it theirs and fresh; empty text removes it", () => {
    const page = twoRows();
    page.addItem(stroke('sup', 82, 92, 86, 100));
    const id = reading(page, 'x^2').id;
    page.editReading(id, 'x^3');
    expect(page.readings().find((r) => r.id === id)).toMatchObject({ text: 'x^3', src: 'user' });
    expect(page.readings().find((r) => r.id === id)!.by).toBeUndefined();
    expect(page.readings().find((r) => r.id === id)!.stale).toBeUndefined();
    page.editReading(id, '  ');
    expect(page.readings().map((r) => r.text)).toEqual(['dx']);
  });

  it('freshCover: text only when every stroke is read by a fresh reading', () => {
    const page = twoRows();
    expect(freshCover(page.readings(), ['a', 'b', 'c', 'z', 'y'])!.map((r) => r.text)).toEqual(['x^2', 'dx']);
    expect(freshCover(page.readings(), ['z', 'y', 'a'])!.map((r) => r.text)).toEqual(['dx', 'x^2']);
    page.addItem(stroke('q', 100, 300, 110, 320));
    expect(freshCover(page.readings(), ['a', 'q'])).toBeNull();
    page.addItem(stroke('sup', 82, 92, 86, 100));
    expect(freshCover(page.readings(), ['a', 'b', 'c'])).toBeNull();
  });

  it('a bulk move of 3000 strokes with readings is one undo step and stays fresh', () => {
    const page = newPage();
    const strokes = Array.from({ length: 3000 }, (_, i) => stroke(`s${i}`, 20 + (i % 50) * 11, 20 + Math.floor(i / 50) * 13, 28 + (i % 50) * 11, 30 + Math.floor(i / 50) * 13));
    page.addItems(strokes);
    for (let r = 0; r < 20; r++) page.setReading(strokes.slice(r * 50, r * 50 + 50).map((s) => s.id), `row ${r}`, 'agent');
    const um = createUndoManager(page);
    const t0 = Date.now();
    move(page, strokes.map((s) => s.id), { s: 1, r: 0, ox: 0, oy: 0, dx: 3, dy: 40 });
    const ms = Date.now() - t0;
    expect(page.readings().every((r) => !r.stale)).toBe(true);
    expect(ms).toBeLessThan(2000);
    um.undo();
    expect((page.item('s0') as { bbox: number[] }).bbox).toEqual([20, 20, 28, 30]);
  });

  it('syncs, and two devices converge', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const pa = twoRows(new Page(a));
    sync(a, b);
    const pb = new Page(b);
    pb.addItem(stroke('sup', 82, 92, 86, 100));
    sync(a, b);
    expect(state(pa)).toEqual(state(pb));
    expect(state(pa)[0]).toEqual(['x^2', 'agent', true]);
  });
});
