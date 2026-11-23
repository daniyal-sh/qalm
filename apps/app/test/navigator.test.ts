import { Notebook, Page, type PageInfo } from '@qalm/core';
import { describe, expect, it } from 'vitest';

import { A4, buildMixedIndex, fillPage, MIXED } from '../src/bench/gen';
import {
  dropGap,
  keyTarget,
  moveIndex,
  NAV_LABEL_H,
  NAV_PAD,
  navEntries,
  navLayout,
  parseGoTo,
  rowOf,
} from '../src/editor/navigator.logic';
import { Thumbnails } from '../src/editor/thumbnails';
import { docIds, DocManager } from '../src/sync/docs';
import { MemoryStorage, SnapshotPersistence } from '../src/sync/snapshot';

const tick = () => new Promise((r) => setTimeout(r, 0));
const until = async (f: () => boolean) => {
  for (let i = 0; i < 200 && !f(); i++) await tick();
};

describe('navigator layout', () => {
  const pages = new Notebook(buildMixedIndex(MIXED)).pages();

  it('is one column in the sidebar and a grid of ~150 px cells full-screen', () => {
    const side = navLayout(216, 'sidebar', pages);
    expect(side.columns).toBe(1);
    expect(side.cellW).toBe(216 - 2 * NAV_PAD);
    expect(side.thumbH).toBe(Math.round(side.cellW * (842 / 595)));
    expect(navLayout(390, 'grid', pages).columns).toBe(2);
    expect(navLayout(1024, 'grid', pages).columns).toBe(6);
  });

  it('filters bookmarked pages, keeping notebook indexes', () => {
    const marked: PageInfo[] = pages.slice(0, 5).map((p, i) => (i % 2 ? { ...p, bookmarked: true } : p));
    expect(navEntries(marked, 'all').map((e) => e.index)).toEqual([0, 1, 2, 3, 4]);
    expect(navEntries(marked, 'bookmarks').map((e) => e.index)).toEqual([1, 3]);
  });

  it('finds the drop gap under the pointer, in a list and in a grid', () => {
    const list = navLayout(216, 'sidebar', pages);
    const y = (row: number, frac: number) => NAV_PAD + row * list.rowH + frac * (list.thumbH + NAV_LABEL_H);
    expect(dropGap(50, y(0, 0.2), list, 300)).toBe(0);
    expect(dropGap(50, y(0, 0.8), list, 300)).toBe(1);
    expect(dropGap(50, y(7, 0.3), list, 300)).toBe(7);
    expect(dropGap(50, y(400, 0.3), list, 300)).toBe(300);
    const grid = navLayout(1024, 'grid', pages);
    const x = (col: number, frac: number) => NAV_PAD + col * (grid.cellW + 12) + frac * grid.cellW;
    expect(dropGap(x(2, 0.2), NAV_PAD + grid.rowH * 1 + 10, grid, 300)).toBe(grid.columns + 2);
    expect(dropGap(x(2, 0.7), NAV_PAD + grid.rowH * 1 + 10, grid, 300)).toBe(grid.columns + 3);
    expect(rowOf(13, grid)).toBe(2);
  });

  it('turns a drop gap into a movePage index', () => {
    expect(moveIndex(2, 0)).toBe(0); // up to the top
    expect(moveIndex(2, 5)).toBe(4); // down: the page left its own slot first
    expect(moveIndex(2, 3)).toBe(2);
  });

  it('parses go-to page numbers and page keys', () => {
    expect(parseGoTo('12', 300)).toBe(11);
    expect(parseGoTo(' 999 ', 300)).toBe(299);
    expect(parseGoTo('0', 300)).toBe(0);
    expect(parseGoTo('abc', 300)).toBeNull();
    expect(parseGoTo('3', 0)).toBeNull();
    expect(keyTarget('PageDown', 5, 300)).toBe(6);
    expect(keyTarget('PageUp', 0, 300)).toBe(0);
    expect(keyTarget('End', 5, 300)).toBe(299);
    expect(keyTarget('Home', 5, 300)).toBe(0);
    expect(keyTarget('ArrowDown', 5, 300)).toBeNull();
  });
});

describe('thumbnails', () => {
  function setup() {
    const storage = new MemoryStorage();
    const dm = new DocManager({ persist: (id, d) => new SnapshotPersistence(id, d, storage, 1), remote: null, cacheSize: 4 });
    const drawn: { id: string; items: number }[] = [];
    const thumbs = new Thumbnails({
      dm,
      notebookId: 'nb',
      pdfUri: async () => null,
      renderPdf: async () => '',
      draw: async ({ info, items }) => {
        drawn.push({ id: info.id, items: items.length });
        return `thumb:${info.id}:${items.length}`;
      },
    });
    const info = (id: string): PageInfo => ({ id, size: A4, paper: 'blank', paperColor: 'white', background: { kind: 'paper' } });
    return { dm, thumbs, drawn, info };
  }

  it('renders on request, one page doc at a time, releasing each', async () => {
    const { dm, thumbs, drawn, info } = setup();
    const h = dm.open(docIds.page('nb', 'a'));
    await h.loaded;
    fillPage(h.doc, 40, A4, 1);
    h.release();
    for (const id of ['a', 'b', 'c']) thumbs.request(info(id), 120);
    await until(() => drawn.length === 3);
    expect(drawn).toEqual([
      { id: 'c', items: 0 },
      { id: 'b', items: 0 },
      { id: 'a', items: 40 },
    ]);
    expect(thumbs.get('a')).toEqual({ uri: 'thumb:a:40', stale: false });
    expect(dm.stats().open).toBe(0);
    // Cached: no second render.
    thumbs.request(info('a'), 120);
    await tick();
    expect(drawn).toHaveLength(3);
    await dm.closeAll();
  });

  it('goes stale when the page changes (locally or synced), and skips cancelled requests', async () => {
    const { dm, thumbs, drawn, info } = setup();
    thumbs.request(info('a'), 120);
    await until(() => drawn.length === 1);
    let notified = 0;
    thumbs.subscribe('a', () => notified++);
    const h = dm.open(docIds.page('nb', 'a'));
    await h.loaded;
    new Page(h.doc).addItem({ id: 't', type: 'text', x: 1, y: 1, w: 40, text: 'hi', fontSize: 12, color: '#000' });
    expect(thumbs.get('a')!.stale).toBe(true);
    expect(notified).toBe(1);
    thumbs.request(info('a'), 120);
    await until(() => drawn.length === 2);
    expect(thumbs.get('a')).toEqual({ uri: 'thumb:a:1', stale: false });
    h.release();

    const block = thumbs.request(info('x'), 120);
    const cancel = thumbs.request(info('y'), 120);
    cancel();
    block();
    await tick();
    await tick();
    expect(drawn.map((d) => d.id)).not.toContain('y');
    await dm.closeAll();
  });
});
