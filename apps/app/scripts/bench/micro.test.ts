// Micro-benchmarks for big notebooks: `pnpm --filter @qalm/app bench:micro` (prints the median ms per call).
import { Notebook, Page, strokeOutline, type StrokeItem } from '@qalm/core';
import { describe, test } from 'vitest';
import * as Y from 'yjs';

import { A4, buildMixedIndex, fillPage, MIXED } from '../../src/bench/gen';
import { makeStroke } from '../../src/editor/items';
import { currentPageIndex, layoutPages, mountedRange } from '../../src/editor/view';

function bench(name: string, fn: () => void): void {
  test(name, () => {
    const times: number[] = [];
    const t0 = performance.now();
    while (times.length < 5 || (performance.now() - t0 < 1500 && times.length < 200)) {
      const s = performance.now();
      fn();
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
  bench('page.lines()', () => {
    page.lines();
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
