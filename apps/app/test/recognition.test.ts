import { createUndoManager, Page } from '@qalm/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { RecognitionScheduler, type RecognizeFn } from '../src/editor/recognition';
import { word as stroke } from './helpers';

describe('RecognitionScheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(result: (keys: string[]) => { key: string; text: string; score: number }[]) {
    const page = new Page(new Y.Doc());
    const calls: string[][] = [];
    const recognize: RecognizeFn = vi.fn(async (lines) => {
      calls.push(lines.map((l) => l.key));
      return result(lines.map((l) => l.key));
    });
    const rec = new RecognitionScheduler(page, recognize);
    rec.start();
    return { page, rec, calls, recognize };
  }

  it('recognizes a line 1 s after its last change and saves device text', async () => {
    const { page, rec, calls } = setup((keys) => keys.map((key) => ({ key, text: 'hello', score: 0.9 })));
    const s1 = stroke(10, 100);
    page.addItem(s1);
    vi.advanceTimersByTime(600);
    page.addItem(stroke(60, 100)); // same line: restarts the debounce
    vi.advanceTimersByTime(600);
    expect(calls).toHaveLength(0);
    vi.advanceTimersByTime(400);
    expect(calls).toEqual([[s1.id]]);
    await rec.idle();
    const line = page.lines()[0]!;
    expect(line.text).toBe('hello');
    expect(line.textSrc).toBe('device');
    expect(line.conf).toBe(0.9);
  });

  it('skips empty results (web/desktop resolve [])', async () => {
    const { page, rec, calls } = setup(() => []);
    page.addItem(stroke(10, 100));
    vi.advanceTimersByTime(1000);
    expect(calls).toHaveLength(1);
    await rec.idle();
    expect(page.lines()[0]!.text).toBeUndefined();
    // no retry loop without a new change
    vi.advanceTimersByTime(5000);
    expect(calls).toHaveLength(1);
  });

  it('drops results for lines that changed while recognizing', async () => {
    let release!: () => void;
    const page = new Page(new Y.Doc());
    const s1 = stroke(10, 100);
    const rec = new RecognitionScheduler(page, () => new Promise((r) => (release = () => r([{ key: s1.id, text: 'old', score: 1 }]))));
    rec.start();
    page.addItem(s1);
    vi.advanceTimersByTime(1000);
    page.addItem(stroke(60, 100));
    release();
    await rec.idle();
    expect(page.lines()[0]!.text).toBeUndefined();
  });

  it('does not create undo steps and ignores remote changes', async () => {
    const { page, rec, calls } = setup((keys) => keys.map((key) => ({ key, text: 'x', score: 1 })));
    const um = createUndoManager(page);
    page.addItem(stroke(10, 100));
    vi.advanceTimersByTime(1000);
    await rec.idle();
    expect(um.undoStack).toHaveLength(1);
    um.undo();
    expect(page.items()).toHaveLength(0);

    const other = new Page(new Y.Doc());
    other.addItem(stroke(10, 300));
    Y.applyUpdate(page.doc, Y.encodeStateAsUpdate(other.doc), 'remote');
    vi.advanceTimersByTime(2000);
    expect(calls).toHaveLength(1);
  });

  it('leaves agent and user text alone', async () => {
    const { page, calls } = setup((keys) => keys.map((key) => ({ key, text: 'x', score: 1 })));
    const s = stroke(10, 100);
    page.addItem(s);
    page.setLineText(s.id, 'trusted', 'user');
    vi.advanceTimersByTime(2000);
    expect(calls).toHaveLength(0);
  });
});
