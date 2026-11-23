// Micro-benchmarks for big notebooks: `pnpm --filter @qalm/app bench:micro` (prints the median ms per call).
import { encodePoints, LOCAL_ORIGIN, Notebook, Page, strokeOutline, type Item, type StrokeItem } from '@qalm/core';
import { describe, test } from 'vitest';
import * as Y from 'yjs';

import { A4, buildMixedIndex, fillPage, MIXED } from '../../src/bench/gen';
import { makeStroke, transformPatch } from '../../src/editor/items';
import { currentPageIndex, layoutPages, mountedRange } from '../../src/editor/view';

/** Times `fn`; with `setup`, each run times only `fn(setup())`. */
function bench<T = void>(name: string, fn: (x: T) => void, setup?: () => T): void {
  test(name, () => {
    const times: number[] = [];
    const t0 = performance.now();
    while (times.length < 5 || (performance.now() - t0 < 1500 && times.length < 200)) {
      const x = setup ? setup() : (undefined as T);
      const s = performance.now();
      fn(x);
      times.push(performance.now() - s);
    }
    times.sort((a, b) => a - b);
    console.log(`${name.padEnd(40)} ${times[times.length >> 1]!.toFixed(3).padStart(9)} ms  (n=${times.length})`);
  });
}

const heavy = new Y.Doc();
fillPage(heavy, 5000, A4, 7);
const page = new Page(heavy);
const items = page.items();
const pages = new Notebook(buildMixedIndex(MIXED)).pages();
const slots = layoutPages(pages, 900, 1, 44, 96);

describe('page with 5000 strokes', () => {
  bench('page.items()', () => {
    page.items();
  });
  bench('page.items() after one added stroke', () => {
    const s = makeStroke({ id: `b${Math.random()}`, tool: 'pen', color: '#000', width: 1.8, points: (items[0] as StrokeItem).points, style: 'fountain', smoothing: 2 });
    page.addItem(s);
    page.items();
    page.removeItems([s.id]);
  });
  bench('page.readings()', () => {
    page.readings();
  });
  bench('strokeOutline x 5000', () => {
    for (const it of items) strokeOutline(it as StrokeItem);
  });
  bench('addItem + removeItems', () => {
    const s = makeStroke({ id: `b${Math.random()}`, tool: 'pen', color: '#000', width: 1.8, points: (items[0] as StrokeItem).points, style: 'fountain', smoothing: 2 });
    page.addItem(s);
    page.removeItems([s.id]);
  });
  bench('load page doc from update', () => {
    const d = new Y.Doc();
    Y.applyUpdate(d, update);
  });
});
const update = Y.encodeStateAsUpdate(heavy);

/** One local transaction of `updateItem`s, like `Page.updateItems` (written this way so it also runs on older cores). */
function updateAll(pg: Page, patch: (it: Item) => Partial<Item>): void {
  const items = pg.items();
  pg.doc.transact(() => items.forEach((it) => pg.updateItem(it.id, patch(it))), LOCAL_ORIGIN);
}

function page3000(): Page {
  const d = new Y.Doc();
  fillPage(d, 3000, A4, 5);
  return new Page(d);
}

/** The same page with an agent's reading of every row (moves then check which readings go stale). */
function page3000read(): Page {
  const d = new Y.Doc();
  fillPage(d, 3000, A4, 5, 32, true);
  return new Page(d);
}

describe('selection commit (3000 strokes; page setup not timed)', () => {
  bench('move 3000 strokes', (pg) => {
    const sim = { s: 1, r: 0, ox: 0, oy: 0, dx: 5, dy: 3 };
    updateAll(pg, (it) => transformPatch(it, sim));
  }, page3000);
  bench('  floor: transformPatch x 3000 only', (pg) => {
    const sim = { s: 1, r: 0, ox: 0, oy: 0, dx: 5, dy: 3 };
    for (const it of pg.items()) transformPatch(it, sim);
  }, page3000);
  bench('  floor: same Yjs writes, no Page bookkeeping', (pg) => {
    const sim = { s: 1, r: 0, ox: 0, oy: 0, dx: 5, dy: 3 };
    const items = pg.doc.getMap<Y.Map<unknown>>('items');
    pg.doc.transact(() => {
      for (const it of pg.items()) {
        const p = transformPatch(it, sim) as Partial<StrokeItem>;
        const m = items.get(it.id)!;
        m.set('points', encodePoints(p.points!));
        m.set('width', p.width);
        m.set('bbox', p.bbox);
      }
    }, LOCAL_ORIGIN);
  }, page3000);
  bench('move 3000 strokes far', (pg) => {
    const sim = { s: 1, r: 0, ox: 0, oy: 0, dx: 0, dy: 300 };
    updateAll(pg, (it) => transformPatch(it, sim));
  }, page3000);
  bench('move 3000 strokes with ~100 readings', (pg) => {
    const sim = { s: 1, r: 0, ox: 0, oy: 0, dx: 0, dy: 300 };
    updateAll(pg, (it) => transformPatch(it, sim));
  }, page3000read);
  bench('rotate + scale 3000 strokes', (pg) => {
    const sim = { s: 0.8, r: 0.2, ox: 300, oy: 400, dx: 0, dy: 0 };
    updateAll(pg, (it) => transformPatch(it, sim));
  }, page3000);
  bench('recolour 3000 strokes', (pg) => {
    updateAll(pg, () => ({ color: '#b91c1c' }));
  }, page3000);
  bench('duplicate 3000 strokes', (pg) => {
    const sim = { s: 1, r: 0, ox: 0, oy: 0, dx: 20, dy: 20 };
    const copies = pg.items().map((it) => ({ ...it, ...transformPatch(it, sim), id: `c-${it.id}` }) as StrokeItem);
    pg.doc.transact(() => copies.forEach((c) => pg.addItem(c)), LOCAL_ORIGIN);
  }, page3000);
  bench('delete 3000 strokes', (pg) => {
    pg.removeItems(pg.items().map((it) => it.id));
  }, page3000);
  bench('erase 300 strokes one by one (one transaction)', (pg) => {
    const ids = pg.items().slice(0, 300).map((it) => it.id);
    pg.doc.transact(() => ids.forEach((id) => pg.removeItems([id])), LOCAL_ORIGIN);
  }, page3000);
});

describe('300-page layout', () => {
  bench('build 300-page index + pages()', () => {
    new Notebook(buildMixedIndex(MIXED)).pages();
  });
  bench('layoutPages(300)', () => {
    layoutPages(pages, 900, 1.5, 44, 96);
  });
  bench('mountedRange + currentPageIndex', () => {
    mountedRange(slots, 200_000, 900, 2);
    currentPageIndex(slots, 200_000, 900);
  });
});
