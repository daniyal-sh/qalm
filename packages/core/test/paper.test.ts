// Changing paper and colour after a notebook is made (audit F21): one undo step, syncs, PDF pages keep their PDF,
// and the default ink follows the paper colour so existing ink stays readable.
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createNotebookUndoManager, DEFAULT_INK, itemsOnPaper, NIGHT_INK, Notebook, type Item } from '../src';
import { newNotebook, stroke, sync } from './helpers';

describe('setPagePaper', () => {
  it('changes one page, or all, in one undo step; PDF pages are skipped', () => {
    const nb = newNotebook();
    const a = nb.pages()[0]!.id;
    const b = nb.addPage();
    const pdf = nb.addPage({ background: { kind: 'pdf', assetId: 'x', pageIndex: 0 } });
    const um = createNotebookUndoManager(nb);
    const before = nb.pages().map((p) => [p.paper, p.paperColor]);

    expect(nb.setPagePaper([b], { paper: 'grid' })).toBe(1);
    expect(nb.pages().find((p) => p.id === b)).toMatchObject({ paper: 'grid' });
    expect(nb.pages().find((p) => p.id === a)!.paper).toBe(before[0]![0]);

    expect(nb.setPagePaper([a, b, pdf], { paper: 'dotted', paperColor: 'night' })).toBe(2);
    expect(nb.pages().map((p) => p.paperColor)).toEqual(['night', 'night', before[2]![1]]);
    expect(nb.pages()[2]!.background.kind).toBe('pdf');
    expect(nb.setPagePaper([a, b], { paper: 'dotted', paperColor: 'night' })).toBe(0); // no-op

    um.undo(); // the "apply to all" step, whole
    expect(nb.pages().map((p) => p.paper)).toEqual([before[0]![0], 'grid', before[2]![0]]);
    um.undo();
    expect(nb.pages().map((p) => [p.paper, p.paperColor])).toEqual(before);
  });

  it('syncs to another device', () => {
    const nb = newNotebook();
    const other = new Notebook(new Y.Doc());
    sync(nb.doc, other.doc);
    nb.setPagePaper([nb.pages()[0]!.id], { paper: 'cornell', paperColor: 'cream' });
    sync(nb.doc, other.doc);
    expect(other.pages()[0]).toMatchObject({ paper: 'cornell', paperColor: 'cream' });
  });
});

describe('itemsOnPaper', () => {
  const g = stroke('g', 0, 0, 10, 10, { color: DEFAULT_INK });
  const n = stroke('n', 0, 0, 10, 10, { color: NIGHT_INK });
  const red = stroke('r', 0, 0, 10, 10, { color: '#b91c1c' });
  const text: Item = { id: 't', type: 'text', x: 0, y: 0, w: 100, text: 'hi', fontSize: 16, color: DEFAULT_INK };
  const img: Item = { id: 'i', type: 'image', assetId: 'a', x: 0, y: 0, w: 10, h: 10 };

  it('draws the default ink in the paper colour and keeps other colours', () => {
    const items = [g, n, red, text, img];
    const night = itemsOnPaper(items, 'night');
    expect(night.map((it) => (it.type === 'image' ? null : it.color))).toEqual([NIGHT_INK, NIGHT_INK, '#b91c1c', NIGHT_INK, null]);
    const light = itemsOnPaper(items, 'white');
    expect(light.map((it) => (it.type === 'image' ? null : it.color))).toEqual([DEFAULT_INK, DEFAULT_INK, '#b91c1c', DEFAULT_INK, null]);
    expect(night[2]).toBe(red); // unchanged items are the same objects
  });

  it('returns the same array when nothing changes, and the same mapped object every time', () => {
    const items = [red, img];
    expect(itemsOnPaper(items, 'night')).toBe(items);
    expect(itemsOnPaper([g], 'night')[0]).toBe(itemsOnPaper([g, red], 'night')[0]);
  });
});
