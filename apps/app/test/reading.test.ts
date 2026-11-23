import { Page, type StrokeItem, type TextItem } from '@qalm/core';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { addReading, MAX_READINGS, readingSource, saveReading, selectionInk, selectionReadings } from '../src/editor/reading.logic';

const stroke = (id: string, x0: number, y0: number, x1: number, y1: number): StrokeItem => ({
  id,
  type: 'stroke',
  tool: 'pen',
  color: '#27272a',
  width: 1.8,
  points: Array.from({ length: 10 }, (_, k) => ({ x: x0 + ((x1 - x0) * k) / 9, y: y0 + ((y1 - y0) * k) / 9, p: 0.5, tilt: Math.PI / 2, az: 0, t: k * 8 })),
  bbox: [x0, y0, x1, y1],
  createdAt: 0,
});
const text: TextItem = { id: 't', type: 'text', x: 300, y: 300, w: 80, text: 'hi', fontSize: 14, color: '#000' };

/** `x^2` (a, b) read by Claude, `dx` (z) unread, far below. */
function setup() {
  const p = new Page(new Y.Doc());
  p.addItems([stroke('a', 50, 100, 60, 120), stroke('b', 62, 100, 70, 120), stroke('z', 50, 400, 60, 420), text]);
  p.setReading(['a', 'b'], 'x^2', 'agent', 'Claude');
  const get = () => p.readings().find((r) => r.ids.includes('a'));
  return { p, get };
}

describe('selection readings', () => {
  it('the ink of a selection (no text boxes or images), and the readings that overlap it, top to bottom', () => {
    const { p } = setup();
    expect(selectionInk(p.items(), ['b', 't', 'z'])).toEqual(['b', 'z']);
    expect(selectionInk(p.items(), ['t'])).toEqual([]); // only a text box: no Reading
    p.setReading(['z'], 'dx', 'user');
    expect(selectionReadings(p.readings(), p.items(), ['z', 'b']).map((r) => r.text)).toEqual(['x^2', 'dx']);
    expect(selectionReadings(p.readings(), p.items(), ['z']).map((r) => r.text)).toEqual(['dx']);
    const q = new Page(new Y.Doc());
    for (let i = 0; i < 20; i++) {
      q.addItem(stroke(`s${i}`, 50, i * 30, 60, i * 30 + 10));
      q.setReading([`s${i}`], `r${i}`, 'agent');
    }
    expect(selectionReadings(q.readings(), q.items(), q.items().map((i) => i.id))).toHaveLength(MAX_READINGS);
  });

  it('names the source', () => {
    expect(readingSource({ src: 'agent', by: 'Claude' })).toEqual({ label: 'Read by Claude', tone: 'agent' });
    expect(readingSource({ src: 'agent' }).label).toBe('Read by your agent');
    expect(readingSource({ src: 'user' })).toEqual({ label: 'Yours', tone: 'user' });
  });
});

describe('saving a reading', () => {
  it("saves the student's text as theirs (agents can't overwrite it)", () => {
    const { p, get } = setup();
    expect(saveReading(p, get()!, '  x² + 1 ')).toBe('saved');
    expect(get()).toMatchObject({ text: 'x² + 1', src: 'user' });
    expect(get()!.by).toBeUndefined();
    expect(p.setReading(['a', 'b'], 'x^3', 'agent', 'Claude')).toBeNull();
  });

  it("leaves an agent's unchanged fresh reading as it is; confirming a stale one makes it the student's", () => {
    const { p, get } = setup();
    expect(saveReading(p, get()!, 'x^2')).toBe('unchanged');
    expect(get()).toMatchObject({ src: 'agent', by: 'Claude' });
    p.addItem(stroke('sup', 72, 92, 76, 100));
    expect(get()!.stale).toBe(true);
    expect(saveReading(p, get()!, 'x^2')).toBe('saved');
    expect(get()).toMatchObject({ src: 'user' });
    expect(get()!.stale).toBeUndefined();
  });

  it('empty text removes it; the student can read unread ink', () => {
    const { p, get } = setup();
    expect(saveReading(p, get()!, '   ')).toBe('removed');
    expect(get()).toBeUndefined();
    expect(addReading(p, ['z'], ' dx ')).toBe('saved');
    expect(p.readings()).toMatchObject([{ ids: ['z'], text: 'dx', src: 'user' }]);
    expect(addReading(p, ['z'], '  ')).toBe('unchanged');
  });
});
