import { createNotebookDoc, Library, Notebook, type LibraryEntry } from '@qalm/core';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { entryMirror, notebookFound, pendingScrollY } from '../src/editor/editor.logic';
import { layoutPages } from '../src/editor/view';

const entry = (id: string, over: Partial<LibraryEntry> = {}): LibraryEntry => ({
  id,
  title: 'Maths',
  cover: '#4338ca',
  folderId: null,
  updatedAt: 1,
  aiAccess: false,
  favorite: false,
  deletedAt: null,
  ...over,
});

describe('notebookFound (F2)', () => {
  it('is false for an empty index doc (a bogus link)', () => {
    const meta = new Notebook(new Y.Doc()).meta();
    expect(notebookFound(meta, 'does-not-exist-123', true, undefined)).toBe(false);
    expect(notebookFound(null, 'x', true, undefined)).toBe(false);
  });

  it('is false once the library has no entry (deleted forever, maybe on another device)', () => {
    const nb = new Notebook(createNotebookDoc({ id: 'nb1', title: 'Maths', cover: '#4338ca', paper: 'ruled', paperColor: 'white', size: { w: 595, h: 842 } }));
    const id = nb.meta().id;
    const lib = new Library(new Y.Doc());
    lib.putEntry(entry(id));
    expect(notebookFound(nb.meta(), id, true, lib.entry(id))).toBe(true);
    lib.removeEntry(id);
    expect(notebookFound(nb.meta(), id, true, lib.entry(id))).toBe(false);
  });

  it('does not need a library that is not loaded yet', () => {
    const nb = new Notebook(createNotebookDoc({ id: 'nb1', title: 'Maths', cover: '#4338ca', paper: 'ruled', paperColor: 'white', size: { w: 595, h: 842 } }));
    expect(notebookFound(nb.meta(), nb.meta().id, false, undefined)).toBe(true);
  });

  it('mirrors only changed meta fields', () => {
    expect(entryMirror({ title: 'Maths', cover: '#4338ca', aiAccess: false }, entry('a'))).toBeNull();
    expect(entryMirror({ title: 'Physics', cover: '#4338ca', aiAccess: true }, entry('a'))).toEqual({ title: 'Physics', cover: '#4338ca', aiAccess: true });
  });
});

describe('pendingScrollY (F10, F31)', () => {
  const size = { w: 595, h: 842 };
  it('waits until the page is laid out, then scrolls to it', () => {
    const before = layoutPages([{ id: 'a', size }], 600, 1, 44, 96);
    expect(pendingScrollY(before, { pageId: 'b' })).toBeNull();
    const after = layoutPages([{ id: 'a', size }, { id: 'b', size }], 600, 1, 44, 96);
    expect(pendingScrollY(after, { pageId: 'b' })).toBe(after[1]!.top - 80);
  });

  it('keeps the same spot on a moved page', () => {
    const slots = layoutPages([{ id: 'b', size }, { id: 'a', size }], 600, 1, 44, 96);
    expect(pendingScrollY(slots, { pageId: 'a', offset: 120 })).toBe(slots[1]!.top + 120);
    expect(pendingScrollY(slots, { pageId: 'b', offset: -500 })).toBe(0);
  });
});
