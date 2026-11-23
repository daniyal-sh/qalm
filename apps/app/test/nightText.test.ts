import { createUndoManager, Page, type TextItem } from '@qalm/core';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { dropEmptyText, recolorPatch, selectionSwatch, typeText } from '../src/editor/items';
import { CrossPageUndo } from '../src/editor/undoStack';
import { stroke } from './helpers';

describe('recolour on night paper (F1)', () => {
  it('maps graphite to night ink, like new ink', () => {
    const s = stroke(0, 0, 10, 0, { color: '#e4e4e7' });
    expect(recolorPatch(s, '#27272a', 'night')).toEqual({ color: '#e4e4e7' });
    expect(recolorPatch(s, '#27272a', 'white')).toEqual({ color: '#27272a' });
    expect(recolorPatch(s, '#b91c1c', 'night')).toEqual({ color: '#b91c1c' });
    expect(recolorPatch(stroke(0, 0, 1, 1, { tool: 'highlighter' }), '#27272a', 'night')).toBeNull();
  });

  it('ticks graphite for night-ink selections', () => {
    const items = [stroke(0, 0, 10, 0, { color: '#e4e4e7' }), stroke(0, 9, 10, 9, { color: '#E4E4E7' })];
    expect(selectionSwatch(items, 'night')).toBe('#27272a');
    expect(selectionSwatch(items, 'white')).toBe('#27272a'); // drawn as graphite on light paper (its paper changed: F21)
    expect(selectionSwatch([...items, stroke(0, 0, 1, 1, { color: '#b91c1c' })], 'night')).toBeNull();
  });
});

describe('text boxes (F9)', () => {
  function setup() {
    let t = 0;
    const undo = new CrossPageUndo(() => t);
    const page = new Page(new Y.Doc());
    undo.attach('p', createUndoManager(page));
    const draft: TextItem = { id: 't1', type: 'text', x: 10, y: 10, w: 200, text: '', fontSize: 16, color: '#27272a' };
    return { undo, page, draft, tick: (ms: number) => (t += ms) };
  }

  it('an abandoned box never reaches the page', () => {
    const { undo, page, draft } = setup();
    expect(typeText(page, undo, draft.id, '   ', draft)).toBe(false);
    expect(dropEmptyText(page, undo, draft.id)).toBe(false);
    expect(page.items()).toHaveLength(0);
    expect(undo.canUndo).toBe(false);
  });

  it('creating and typing are one undo step', () => {
    const { undo, page, draft, tick } = setup();
    typeText(page, undo, draft.id, 'H', draft);
    tick(300);
    typeText(page, undo, draft.id, 'Hi', draft);
    expect((page.item(draft.id) as TextItem).text).toBe('Hi');
    undo.undo();
    expect(page.items()).toHaveLength(0);
    expect(undo.canUndo).toBe(false);
  });

  it('a box typed then emptied goes on blur, and undo does not bring back an empty box', () => {
    const { undo, page, draft, tick } = setup();
    typeText(page, undo, draft.id, 'Hi', draft);
    tick(5000);
    typeText(page, undo, draft.id, 'Hi there', draft);
    tick(5000);
    typeText(page, undo, draft.id, '', draft);
    tick(60_000);
    expect(dropEmptyText(page, undo, draft.id)).toBe(true);
    expect(page.items()).toHaveLength(0);
    undo.undo(); // the emptying and the removal together
    expect((page.item(draft.id) as TextItem).text).toBe('Hi there');
  });
});
