import { createUndoManager, Page } from '@qalm/core';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { CrossPageUndo } from '../src/editor/undoStack';
import { stroke } from './helpers';

function setup() {
  let t = 0;
  const undo = new CrossPageUndo(() => t);
  const a = new Page(new Y.Doc());
  const b = new Page(new Y.Doc());
  undo.attach('a', createUndoManager(a));
  undo.attach('b', createUndoManager(b));
  return { undo, a, b, tick: (ms: number) => (t += ms) };
}

describe('CrossPageUndo', () => {
  it('undoes across pages in the order the edits happened', () => {
    const { undo, a, b } = setup();
    a.addItem(stroke(0, 0, 10, 0));
    b.addItem(stroke(0, 0, 10, 0));
    a.addItem(stroke(0, 20, 10, 20));
    expect(undo.canUndo).toBe(true);
    expect(undo.undo()).toBe('a');
    expect(a.items()).toHaveLength(1);
    expect(undo.undo()).toBe('b');
    expect(b.items()).toHaveLength(0);
    expect(undo.undo()).toBe('a');
    expect(a.items()).toHaveLength(0);
    expect(undo.undo()).toBeNull();
    expect(undo.canUndo).toBe(false);
  });

  it('redoes in reverse, and a new edit clears redo', () => {
    const { undo, a, b } = setup();
    a.addItem(stroke(0, 0, 10, 0));
    b.addItem(stroke(0, 0, 10, 0));
    undo.undo();
    undo.undo();
    expect(undo.redo()).toBe('a');
    expect(a.items()).toHaveLength(1);
    expect(undo.canRedo).toBe(true);
    a.addItem(stroke(0, 30, 10, 30));
    expect(undo.canRedo).toBe(false);
    expect(undo.redo()).toBeNull();
    expect(undo.undo()).toBe('a');
    expect(a.items()).toHaveLength(1);
  });

  it('never undoes remote edits', () => {
    const { undo, a } = setup();
    a.addItem(stroke(0, 0, 10, 0));
    const remote = new Page(new Y.Doc());
    remote.addItem(stroke(50, 50, 60, 50));
    Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(remote.doc), 'remote');
    expect(a.items()).toHaveLength(2);
    expect(undo.undo()).toBe('a');
    expect(a.items()).toHaveLength(1);
    expect(undo.undo()).toBeNull();
  });

  it('merges one eraser gesture into one entry', () => {
    const { undo, a, tick } = setup();
    const items = [stroke(0, 0, 10, 0), stroke(0, 20, 10, 20), stroke(0, 40, 10, 40)];
    for (const it of items) a.addItem(it);
    for (const it of items) {
      tick(50);
      undo.merging('erase', () => a.removeItems([it.id]));
    }
    expect(a.items()).toHaveLength(0);
    undo.undo();
    expect(a.items()).toHaveLength(3);
    // a later gesture (after the window) is a separate entry
    tick(5000);
    undo.merging('erase', () => a.removeItems([items[0]!.id]));
    tick(5000);
    undo.merging('erase', () => a.removeItems([items[1]!.id]));
    undo.undo();
    expect(a.items()).toHaveLength(2);
  });

  it('skips pages that were detached (doc evicted)', () => {
    const { undo, a, b } = setup();
    a.addItem(stroke(0, 0, 10, 0));
    b.addItem(stroke(0, 0, 10, 0));
    undo.detach('b');
    expect(undo.undo()).toBe('a');
    expect(b.items()).toHaveLength(1);
  });
});
