import { Page, type Line, type StrokeItem } from '@qalm/core';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { MAX_READING_LINES, readingSource, resetReading, saveReading, selectionLines } from '../src/editor/reading.logic';

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

const line = (key: string, y: number, extra: Partial<Line> = {}): Line => ({ key, kind: 'line', itemIds: [key, `${key}2`], bbox: [50, y, 200, y + 20], ...extra });

describe('selectionLines', () => {
  it('keeps handwritten lines the selection touches, top to bottom, never drawings', () => {
    const lines = [line('b', 300), line('a', 100), { ...line('d', 200), kind: 'drawing' as const }, line('c', 500)];
    expect(selectionLines(lines, ['b2', 'a', 'd', 'img1']).map((l) => l.key)).toEqual(['a', 'b']);
    expect(selectionLines(lines, ['d', 'img1'])).toEqual([]); // only a drawing and an image: no Reading
    const many = Array.from({ length: 20 }, (_, i) => line(`l${i}`, i * 30));
    expect(selectionLines(many, many.map((l) => l.key))).toHaveLength(MAX_READING_LINES);
  });
});

describe('readingSource', () => {
  it('names the source', () => {
    expect(readingSource({})).toEqual({ label: 'No reading yet', tone: 'none' });
    expect(readingSource({ text: 'x', textSrc: 'device' })).toEqual({ label: 'On-device guess', tone: 'device' });
    expect(readingSource({ text: 'x', textSrc: 'agent', by: 'Claude' })).toEqual({ label: 'Read by Claude', tone: 'agent' });
    expect(readingSource({ text: 'x', textSrc: 'agent' }).label).toBe('Read by your agent');
    expect(readingSource({ text: 'x', textSrc: 'user' })).toEqual({ label: 'Yours', tone: 'user' });
  });
});

describe('saveReading', () => {
  const setup = () => {
    const p = new Page(new Y.Doc());
    p.addItems([stroke('a', 50, 100, 60, 120), stroke('b', 62, 100, 70, 120)]);
    p.setLineText('a', 'x^2', 'agent', undefined, 'Claude');
    const get = () => p.lines().find((l) => l.key === 'a')!;
    return { p, get };
  };

  it("saves the student's text as theirs", () => {
    const { p, get } = setup();
    expect(saveReading(p, get(), '  x² + 1 ')).toBe('saved');
    expect(get()).toMatchObject({ text: 'x² + 1', textSrc: 'user' });
    expect(get().by).toBeUndefined();
  });

  it('leaves an unchanged automatic reading automatic', () => {
    const { p, get } = setup();
    expect(saveReading(p, get(), 'x^2')).toBe('unchanged');
    expect(get()).toMatchObject({ textSrc: 'agent', by: 'Claude' });
  });

  it('empty text or reset goes back to automatic', () => {
    const { p, get } = setup();
    expect(saveReading(p, get(), '   ')).toBe('cleared');
    expect(get().text).toBeUndefined();
    expect(saveReading(p, get(), '')).toBe('unchanged');
    saveReading(p, get(), 'mine');
    expect(resetReading(p, get())).toBe(true);
    expect(get().text).toBeUndefined();
    p.setLineText('a', 'guess', 'device', 0.4);
    expect(resetReading(p, get())).toBe(false); // only the student's own text resets
    expect(get().text).toBe('guess');
  });
});
