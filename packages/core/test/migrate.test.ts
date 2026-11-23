import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createUndoManager, migratePage, MIGRATION_ORIGIN, needsMigration, Page, threadBox } from '../src';
import { stroke, sync } from './helpers';

/** A page doc as notebooks from before regions stored it: items with `line` fields, a `lines` map, line comments. */
function legacyDoc(): Y.Doc {
  const doc = new Y.Doc();
  const page = new Page(doc);
  page.addItems([stroke('a', 50, 100, 60, 120), stroke('b', 62, 100, 70, 120), stroke('z', 50, 300, 60, 320), stroke('q', 50, 400, 60, 420)]);
  doc.transact(() => {
    const items = doc.getMap<Y.Map<unknown>>('items');
    items.get('a')!.set('line', 'a');
    items.get('b')!.set('line', 'a');
    items.get('z')!.set('line', 'z');
    items.get('q')!.set('line', 'q');
    const lines = doc.getMap<Y.Map<unknown>>('lines');
    const entry = (key: string, f: Record<string, unknown>) => {
      const m = new Y.Map<unknown>();
      lines.set(key, m);
      m.set('kind', 'line');
      for (const [k, v] of Object.entries(f)) m.set(k, v);
    };
    entry('a', { text: 'x^2', textSrc: 'agent', by: 'Claude' });
    entry('z', { text: 'dx', textSrc: 'user' });
    entry('q', { text: 'qq', textSrc: 'device', conf: 0.7 });
    const comments = doc.getMap<Y.Map<unknown>>('comments');
    const comment = (id: string, f: Record<string, unknown>) => {
      const m = new Y.Map<unknown>();
      comments.set(id, m);
      for (const [k, v] of Object.entries({ id, author: { kind: 'agent', name: 'Claude' }, text: id, createdAt: 1, resolved: false, replies: new Y.Array(), ...f })) m.set(k, v);
    };
    comment('c-line', { lineKey: 'a' });
    comment('c-sel', { lineKey: 'z', anchorIds: ['z'], anchor: [1, 2, 3, 4] });
    comment('c-none', { lineKey: '' });
  });
  return doc;
}

describe('migration from lines', () => {
  it('anchors line comments to their strokes, keeps trusted text as readings, drops guesses and lines', () => {
    const doc = legacyDoc();
    expect(needsMigration(doc)).toBe(true);
    const origins: unknown[] = [];
    doc.on('update', (_u: Uint8Array, o: unknown) => origins.push(o));
    expect(migratePage(doc)).toBe(true);
    expect(origins).toEqual([MIGRATION_ORIGIN]);
    const page = new Page(doc);
    const byId = Object.fromEntries(page.comments().map((c) => [c.id, c]));
    expect(byId['c-line']).toMatchObject({ anchorIds: ['a', 'b'], anchor: [50, 100, 70, 120] });
    expect(threadBox(byId['c-line']!, page.items())).toEqual([50, 100, 70, 120]);
    expect(byId['c-sel']).toMatchObject({ anchorIds: ['z'], anchor: [1, 2, 3, 4] });
    expect(byId['c-none']!.anchorIds).toBeUndefined();
    expect(page.readings().map((r) => [r.id, r.ids, r.text, r.src, r.by ?? null]).sort()).toEqual([
      ['m:a', ['a', 'b'], 'x^2', 'agent', 'Claude'],
      ['m:z', ['z'], 'dx', 'user', null],
    ]);
    expect(doc.getMap('lines').size).toBe(0);
    for (const m of doc.getMap<Y.Map<unknown>>('items').values()) expect(m.has('line')).toBe(false);
    for (const m of doc.getMap<Y.Map<unknown>>('comments').values()) expect(m.has('lineKey')).toBe(false);
    expect(needsMigration(doc)).toBe(false);
  });

  it('is idempotent and not undoable', () => {
    const doc = legacyDoc();
    const um = createUndoManager(new Page(doc));
    migratePage(doc);
    const once = JSON.stringify(doc.toJSON());
    expect(migratePage(doc)).toBe(false);
    expect(JSON.stringify(doc.toJSON())).toBe(once);
    expect(um.canUndo()).toBe(false);
  });

  it('two devices migrating the same page at once converge to one set of readings', () => {
    const a = legacyDoc();
    const b = new Y.Doc();
    sync(a, b);
    migratePage(a);
    migratePage(b);
    sync(a, b);
    expect(JSON.stringify(new Page(a).readings())).toBe(JSON.stringify(new Page(b).readings()));
    expect(new Page(a).readings()).toHaveLength(2);
    expect(needsMigration(a) || needsMigration(b)).toBe(false);
  });

  it('a migrated page behaves like any other (stale rules apply)', () => {
    const doc = legacyDoc();
    migratePage(doc);
    const page = new Page(doc);
    page.addItem(stroke('sup', 72, 92, 76, 100));
    expect(page.readings().find((r) => r.id === 'm:a')!.stale).toBe(true);
  });
});
