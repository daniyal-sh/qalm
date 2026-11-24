import { createUndoManager, Page, UNITS_PER_MM, type InkPoint, type StrokeItem } from '@qalm/core';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { bakeErase, cloneItems, eraseAlong, makeStroke, scribbleErase } from '../src/editor/items';
import { loadInputPrefs } from '../src/lib/inputPrefs';
import type { InputPrefs } from '../src/theme/ThemeProvider';
import { CrossPageUndo } from '../src/editor/undoStack';

let n = 0;
const ids = () => `n${++n}`;

function line(id: string, x0: number, x1: number, y: number): StrokeItem {
  const points: InkPoint[] = [];
  for (let x = x0, i = 0; x <= x1; x += 2, i++) points.push({ x, y, p: 0.3 + i / 200, tilt: 1.3, az: 0, t: i * 4 });
  return makeStroke({ id, tool: 'pen', color: '#27272a', width: 1.8, points, style: 'ball', smoothing: 2 });
}

function setup() {
  let now = 0;
  const undo = new CrossPageUndo(() => now);
  const page = new Page(new Y.Doc());
  undo.attach('p', createUndoManager(page));
  return { undo, page, tick: (ms: number) => (now += ms) };
}

/** A quick back-and-forth scribble (page units) over x0..x1, y0..y1. */
function scribble(x0: number, x1: number, y0: number, y1: number, legs = 10): InkPoint[] {
  const out: InkPoint[] = [];
  let t = 0;
  for (let i = 0; i <= legs; i++) {
    const y = y0 + ((y1 - y0) * i) / legs;
    const [a, b] = i % 2 ? [x1, x0] : [x0, x1];
    for (let k = 0; k <= 20; k++) {
      out.push({ x: a + ((b - a) * k) / 20, y: y + ((y1 - y0) / legs) * (k / 20), p: 0.5, tilt: 1.2, az: 0, t });
      t += 4; // 240 Hz-ish
    }
  }
  return out;
}

describe('the eraser in the editor', () => {
  it('partial: a gesture splits a stroke over several segments; one undo restores it as it was', () => {
    const { undo, page, tick } = setup();
    page.addItem(line('s', 0, 200, 100));
    for (const x of [60, 70, 80, 140, 150]) {
      eraseAlong(page, undo, [{ x, y: 95 }, { x: x + 10, y: 105 }], 6, 'partial', ids);
      tick(16);
    }
    const strokes = page.items() as StrokeItem[];
    expect(strokes.length).toBe(3);
    // The longest piece keeps the stroke's id (updated in place); the others are new and say where they came from.
    expect(strokes.filter((s) => s.id === 's')).toHaveLength(1);
    expect(strokes.filter((s) => s.id !== 's').every((s) => s.splitFrom === 's')).toBe(true);
    expect(strokes.every((s) => s.style === 'ball' && s.smoothing === 2)).toBe(true);
    expect(undo.canUndo).toBe(true);
    undo.undo();
    expect(page.items().map((i) => i.id)).toEqual(['s']);
    expect((page.item('s') as StrokeItem).points).toHaveLength(line('s', 0, 200, 100).points.length);
    undo.redo();
    expect(page.items()).toHaveLength(3);
  });

  it("partial: the pen-up bakes the cut into real points, inside the gesture's one undo step", () => {
    const { undo, page, tick } = setup();
    page.addItem(line('s', 0, 200, 100));
    const cut = new Set<string>();
    for (const x of [0, 10, 20]) {
      eraseAlong(page, undo, [{ x, y: 95 }, { x: x + 10, y: 105 }], 6, 'partial', ids, cut);
      tick(16);
    }
    expect([...cut]).toEqual(['s']);
    const items = page.doc.getMap<Y.Map<unknown>>('items');
    expect(items.get('s')!.has('cutFrom')).toBe(true);
    const kept = (page.item('s') as StrokeItem).points.map((q) => q.x);
    bakeErase(page, undo, cut);
    expect(cut.size).toBe(0);
    expect(items.get('s')!.has('cutFrom')).toBe(false);
    expect((page.item('s') as StrokeItem).points.map((q) => q.x)).toEqual(kept);
    undo.undo(); // one undo: the cuts and the bake
    expect((page.item('s') as StrokeItem).points).toHaveLength(line('s', 0, 200, 100).points.length);
    // The next undo takes back adding the line: that one undo covered the whole gesture, bake included.
    undo.undo();
    expect(page.items()).toEqual([]);
    undo.redo();
    undo.redo();
    expect((page.item('s') as StrokeItem).points.map((q) => q.x)).toEqual(kept);
    expect(items.get('s')!.has('cutFrom')).toBe(false);
  });

  it('copies of a piece are new ink (no splitFrom)', () => {
    const piece = { ...line('p', 0, 20, 10), splitFrom: 's' };
    const [copy] = cloneItems([piece], 5, 5, ids) as [StrokeItem];
    expect(copy.splitFrom).toBeUndefined();
    expect(copy.id).not.toBe('p');
  });

  it('whole stroke: removes what it touches', () => {
    const { undo, page } = setup();
    page.addItems([line('a', 0, 200, 100), line('b', 0, 200, 140)]);
    expect(eraseAlong(page, undo, [{ x: 50, y: 95 }, { x: 50, y: 105 }], 4, 'stroke', ids)).toBe(true);
    expect(page.items().map((i) => i.id)).toEqual(['b']);
    expect(eraseAlong(page, undo, [{ x: 50, y: 300 }], 4, 'stroke', ids)).toBe(false);
  });
});

const DEFAULT_INPUT: InputPrefs = { drawWith: 'any', drawWithAuto: true, penSeen: false, hand: 'right', palm: 'standard', penGesture: 'eraser', smoothing: 'medium', scribbleErase: true };

describe('scribble to erase in the editor', () => {
  it('a scribble over ink deletes it in one undo step and returns it for the fade; the scribble is not added', () => {
    const { undo, page } = setup();
    page.addItems([line('a', 100, 180, 100), line('far', 100, 180, 400)]);
    const gone = scribbleErase(page, scribble(95, 185, 92, 108), 1.8);
    expect(gone?.map((i) => i.id)).toEqual(['a']);
    expect(page.items().map((i) => i.id)).toEqual(['far']);
    undo.undo();
    expect(page.items().map((i) => i.id).sort()).toEqual(['a', 'far']);
  });

  it('a scribble over empty paper keeps nothing from happening (it stays ink)', () => {
    const { page } = setup();
    page.addItem(line('far', 100, 180, 400));
    expect(scribbleErase(page, scribble(95, 185, 92, 92 + 6 * UNITS_PER_MM), 1.8)).toBeNull();
    expect(page.items()).toHaveLength(1);
  });

  it('a saved choice is kept; anything else keeps the default (on)', () => {
    expect(loadInputPrefs({ scribbleErase: false }, DEFAULT_INPUT).scribbleErase).toBe(false);
    expect(loadInputPrefs({}, DEFAULT_INPUT).scribbleErase).toBe(true);
    expect(loadInputPrefs({ scribbleErase: 'yes' as never }, DEFAULT_INPUT).scribbleErase).toBe(true);
  });
});
