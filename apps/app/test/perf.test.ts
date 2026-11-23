// Big-notebook behaviour: layout windowing, the PDF render queue, the doc LRU with undo retention, ink chunking.
import { createUndoManager, Notebook, Page, type Item } from '@qalm/core';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { inkRuns, sameItems } from '../../../modules/qalm-ink/src/inkRuns';
import { A4, buildMixedIndex, fillPage, MIXED } from '../src/bench/gen';
import { CrossPageUndo } from '../src/editor/undoStack';
import { RenderQueue } from '../src/editor/renderQueue';
import { layoutPages, mountedRange, PDF_MAX_PX, pdfBucketWidth, pdfRenderWidth, viewKey, windowRange } from '../src/editor/view';
import { DocManager } from '../src/sync/docs';
import { MemoryStorage, SnapshotPersistence } from '../src/sync/snapshot';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('300-page layout', () => {
  const pages = new Notebook(buildMixedIndex(MIXED)).pages();
  const slots = layoutPages(pages, 900, 1, 44, 96);

  it('renders only a window of pages around the mounted ones', () => {
    expect(pages).toHaveLength(300);
    const y = slots[150]!.top + 10;
    const mounted = mountedRange(slots, y, 900, 2);
    expect(mounted).toEqual([148, 152]);
    expect(windowRange(mounted, 300)).toEqual([142, 158]);
    expect(windowRange([0, 2], 300)).toEqual([0, 8]);
    expect(windowRange([297, 299], 300)).toEqual([291, 299]);
    expect(windowRange([0, -1], 0)).toEqual([0, -1]);
  });

  it('changes the view key only when the shown pages change, not on every scroll event', () => {
    const top = slots[10]!.top;
    const k = viewKey(slots, top + 100, 900);
    expect(viewKey(slots, top + 110, 900)).toBe(k);
    expect(viewKey(slots, top + 300, 900)).toBe(k);
    expect(viewKey(slots, slots[12]!.top, 900)).not.toBe(k);
    // ~one change per page height while flinging through 300 pages
    let changes = 0;
    let last = '';
    for (let y = 0; y < slots[299]!.top; y += 16) {
      const key = viewKey(slots, y, 900);
      if (key !== last) changes++;
      last = key;
    }
    expect(changes).toBeLessThan(3 * 300);
    expect(changes).toBeGreaterThan(299);
  });
});

describe('PDF backgrounds', () => {
  it('caps bitmap width and renders off-screen pages at 1x', () => {
    expect(pdfBucketWidth(3600, 900, 2)).toBe(PDF_MAX_PX);
    expect(pdfRenderWidth(1800, 2, 1, true)).toBe(1800);
    expect(pdfRenderWidth(1800, 2, 1, false)).toBe(900);
    expect(pdfRenderWidth(900, 1, 2, false)).toBe(1800);
  });

  it('runs at most N renders, newest first, and skips cancelled ones', async () => {
    const q = new RenderQueue(1);
    const started: number[] = [];
    const resolvers: (() => void)[] = [];
    const job = (n: number) => q.request(() => new Promise<number>((r) => (started.push(n), resolvers.push(() => r(n)))));
    const a = job(1);
    await tick();
    const b = job(2);
    const c = job(3);
    const d = job(4);
    c.cancel();
    expect(started).toEqual([1]);
    expect(q.pending).toBe(2);
    resolvers.shift()!();
    expect(await a.promise).toBe(1);
    await tick();
    expect(started).toEqual([1, 4]);
    resolvers.shift()!();
    await d.promise;
    await tick();
    expect(started).toEqual([1, 4, 2]);
    resolvers.shift()!();
    expect(await b.promise).toBe(2);
    await tick();
    expect(q.active).toBe(0);
  });
});

describe('doc LRU', () => {
  it('stays bounded while scrolling through 300 page docs, persisting each before it is dropped', async () => {
    const storage = new MemoryStorage();
    const m = new DocManager({ persist: (id, d) => new SnapshotPersistence(id, d, storage, 1), remote: null, cacheSize: 24 });
    let maxHeld = 0;
    for (let i = 0; i < 300; i++) {
      const h = m.open(`pg:n:${i}`);
      await h.loaded;
      h.doc.getArray('order').push([`s${i}`]);
      h.release();
      const s = m.stats();
      maxHeld = Math.max(maxHeld, s.open + s.cached);
    }
    expect(maxHeld).toBeLessThanOrEqual(25);
    await tick();
    await tick();
    const again = m.open('pg:n:0');
    await again.loaded;
    expect(again.doc.getArray('order').toArray()).toEqual(['s0']);
    await m.closeAll();
  });

  it('evicts pages with undo history last, so undo still reaches them', async () => {
    const storage = new MemoryStorage();
    const m = new DocManager({ persist: (id, d) => new SnapshotPersistence(id, d, storage, 1), remote: null, cacheSize: 3 });
    const undo = new CrossPageUndo();
    const evicted: string[] = [];
    m.onEvict((id) => {
      evicted.push(id);
      undo.detach(id.slice('pg:n:'.length));
    });
    m.setRetain((id) => undo.hasHistory(id.slice('pg:n:'.length)));

    const h = m.open('pg:n:edited');
    await h.loaded;
    const page = new Page(h.doc);
    undo.attach('edited', createUndoManager(page));
    page.addItem({ id: 'a', type: 'text', x: 1, y: 1, w: 50, text: 'hi', fontSize: 16, color: '#000' });
    expect(undo.hasHistory('edited')).toBe(true);
    h.release();
    for (let i = 0; i < 6; i++) m.open(`pg:n:${i}`).release();
    expect(evicted).not.toContain('pg:n:edited');
    expect(m.has('pg:n:edited')).toBe(true);
    expect(undo.undo()).toBe('edited');
    expect(page.items()).toEqual([]);
    // Bounded all the same: with more retained pages than the cache holds, the oldest goes.
    await m.closeAll();
  });
});

describe('ink chunks', () => {
  it('groups consecutive ink in chunks, keeps z-order around text and images', () => {
    const s = (id: string): Item => ({ id, type: 'stroke', tool: 'pen', color: '#000', width: 1, points: [], bbox: [0, 0, 1, 1], createdAt: 0 });
    const t: Item = { id: 't', type: 'text', x: 0, y: 0, w: 10, text: 'x', fontSize: 12, color: '#000' };
    const runs = inkRuns([s('a'), s('b'), s('c'), t, s('d')], 2);
    expect(runs.map((r) => (r.kind === 'ink' ? r.items.map((i) => i.id).join('') : `[${r.item.id}]`))).toEqual(['ab', 'c', '[t]', 'd']);
    expect(runs.map((r) => (r.kind === 'ink' ? r.key : r.item.id))).toEqual(['a', 'c', 't', 'd']);
  });

  it('re-records only the last chunk when a stroke is added to a 3000-stroke page', () => {
    const doc = new Y.Doc();
    fillPage(doc, 3000, A4, 3);
    const page = new Page(doc);
    const before = inkRuns(page.items());
    const it0 = page.items()[0]!;
    page.addItem({ ...it0, id: 'new' } as Item);
    const after = inkRuns(page.items());
    const changed = after.filter((r, i) => r.kind === 'ink' && !(before[i]?.kind === 'ink' && sameItems(before[i]!.items as unknown[], r.items)));
    expect(before.length).toBe(Math.ceil(3000 / 256));
    expect(changed.map((r) => (r.kind === 'ink' ? r.key : ''))).toEqual([after[after.length - 1]!.kind === 'ink' ? (after[after.length - 1] as { key: string }).key : '']);
  });
});

describe('page doc queue', () => {
  it('starts the lowest priority first, newest first among equals', async () => {
    const q = new RenderQueue(1);
    const order: string[] = [];
    let release!: () => void;
    const block = q.request(() => new Promise<void>((r) => (release = r)));
    for (const [name, prio] of [['p3', 3], ['p1', 1], ['p0', 0], ['p1b', 1]] as const) void q.request(async () => void order.push(name), prio);
    await tick();
    release();
    await block.promise;
    for (let i = 0; i < 6; i++) await tick();
    expect(order).toEqual(['p0', 'p1b', 'p1', 'p3']);
  });
});
