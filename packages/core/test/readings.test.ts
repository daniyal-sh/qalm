// A line's saved reading (an agent's transcription, the device's guess, the student's text) survives edits that keep
// the line's items, such as moving, resizing or rotating the whole line, and is cleared when items join or leave it.
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createUndoManager, LOCAL_ORIGIN, moveBy, Page, transformPatch } from '../src';
import type { Sim } from '../src';
import { newPage, stroke, sync } from './helpers';

/** Two rows: line `a` (a, b, c) and line `z` (z, y). */
function twoLines(page = newPage()): Page {
  page.addItems([stroke('a', 50, 100, 60, 120), stroke('b', 62, 100, 70, 120), stroke('c', 72, 100, 80, 120), stroke('z', 50, 300, 60, 320), stroke('y', 62, 300, 70, 320)]);
  page.setLineText('a', 'x^2', 'agent');
  page.setLineText('z', 'dx', 'device', 0.8);
  return page;
}

const reading = (p: Page, key: string) => {
  const l = p.lines().find((x) => x.key === key);
  return l && { itemIds: l.itemIds, text: l.text, textSrc: l.textSrc, conf: l.conf };
};

const move = (p: Page, ids: string[], f: Sim) => p.updateItems(ids.map((id) => [id, transformPatch(p.item(id)!, f)] as const));

describe('line readings', () => {
  it('a whole line moved, resized or rotated keeps its key and reading', () => {
    const p = twoLines();
    move(p, ['a', 'b', 'c'], moveBy(0, 400)); // far enough that every item leaves its old row
    expect(reading(p, 'a')).toEqual({ itemIds: ['a', 'b', 'c'], text: 'x^2', textSrc: 'agent', conf: undefined });
    move(p, ['a', 'b', 'c'], { s: 1.3, r: 0.05, ox: 50, oy: 300, dx: 0, dy: 0 });
    expect(reading(p, 'a')).toMatchObject({ itemIds: ['a', 'b', 'c'], text: 'x^2', textSrc: 'agent' });
    // Both lines at once (a select-all drag), the device's guess with its confidence too.
    move(p, ['a', 'b', 'c', 'z', 'y'], moveBy(40, -60));
    expect(reading(p, 'a')).toMatchObject({ text: 'x^2', textSrc: 'agent' });
    expect(reading(p, 'z')).toEqual({ itemIds: ['z', 'y'], text: 'dx', textSrc: 'device', conf: 0.8 });
  });

  it('also when the items are updated one by one inside one transaction', () => {
    const p = twoLines();
    p.doc.transact(() => {
      for (const id of ['c', 'a', 'b']) p.updateItem(id, transformPatch(p.item(id)!, moveBy(0, 400)));
    }, LOCAL_ORIGIN);
    expect(reading(p, 'a')).toMatchObject({ itemIds: ['a', 'b', 'c'], text: 'x^2', textSrc: 'agent' });
  });

  it('is cleared when items join or leave the line', () => {
    let p = twoLines();
    p.addItem(stroke('d', 82, 100, 90, 120)); // joins a
    expect(reading(p, 'a')).toMatchObject({ itemIds: ['a', 'b', 'c', 'd'], text: undefined });
    expect(reading(p, 'z')).toMatchObject({ text: 'dx' }); // untouched

    p = twoLines();
    p.removeItems(['b']); // erased from a
    expect(reading(p, 'a')).toMatchObject({ itemIds: ['a', 'c'], text: undefined });

    p = twoLines();
    move(p, ['c'], moveBy(-22, 200)); // c leaves a and joins z
    expect(reading(p, 'a')).toMatchObject({ itemIds: ['a', 'b'], text: undefined });
    expect(reading(p, 'z')).toMatchObject({ itemIds: ['c', 'z', 'y'], text: undefined });

    p = twoLines();
    move(p, ['a', 'b'], moveBy(0, 250)); // part of a line moved away: both parts are new readings
    expect(reading(p, 'a')).toMatchObject({ itemIds: ['a', 'b'], text: undefined });
    expect(reading(p, 'c')).toMatchObject({ itemIds: ['c'], text: undefined });
  });

  it("the student's own reading is never cleared", () => {
    const p = twoLines();
    p.setLineText('a', 'x squared', 'user');
    p.addItem(stroke('d', 82, 100, 90, 120));
    expect(reading(p, 'a')).toMatchObject({ itemIds: ['a', 'b', 'c', 'd'], text: 'x squared', textSrc: 'user' });
  });

  it('a reading saved during the transaction is of the items at that point', () => {
    const p = twoLines();
    p.doc.transact(() => {
      p.addItem(stroke('d', 82, 100, 90, 120));
      p.setLineText('a', 'x^2+1', 'agent');
    }, LOCAL_ORIGIN);
    expect(reading(p, 'a')).toMatchObject({ itemIds: ['a', 'b', 'c', 'd'], text: 'x^2+1' });
  });

  it('moving the items in separate transactions (one undo step each) is a change per step', () => {
    const p = twoLines();
    for (const id of ['a', 'b', 'c']) p.updateItem(id, transformPatch(p.item(id)!, moveBy(0, 400)));
    expect(reading(p, 'a')).toMatchObject({ itemIds: ['a', 'b', 'c'], text: undefined });
  });

  it('undo and redo of a move keep the reading; other devices get the same', () => {
    const p = twoLines();
    const remote = new Page(new Y.Doc());
    sync(p.doc, remote.doc);
    const undo = createUndoManager(p);
    move(p, ['a', 'b', 'c'], moveBy(0, 400));
    sync(p.doc, remote.doc);
    expect(reading(remote, 'a')).toEqual(reading(p, 'a'));
    expect(reading(remote, 'a')).toMatchObject({ text: 'x^2', textSrc: 'agent' });
    undo.undo();
    expect(reading(p, 'a')).toMatchObject({ itemIds: ['a', 'b', 'c'], text: 'x^2' });
    expect(p.item('a')).toMatchObject({ bbox: [50, 100, 60, 120] });
    undo.redo();
    expect(reading(p, 'a')).toMatchObject({ itemIds: ['a', 'b', 'c'], text: 'x^2' });
  });
});
