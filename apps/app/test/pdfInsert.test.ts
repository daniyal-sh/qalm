import { describe, expect, it } from 'vitest';

import { isPdfNotebook, newPageAfter } from '../src/editor/view';

const pdf = (i: number, w = 612, h = 792) => ({ size: { w, h }, paper: 'blank' as const, paperColor: 'white' as const, background: { kind: 'pdf' as const, assetId: 'a', pageIndex: i } });
const written = (paper: 'blank' | 'ruled' | 'grid', paperColor: 'white' | 'cream' = 'white') => ({ size: { w: 595, h: 842 }, paper, paperColor, background: { kind: 'paper' as const } });

describe('inserting pages into a PDF notebook', () => {
  it('only PDF notebooks get the insert button', () => {
    expect(isPdfNotebook([pdf(0), written('ruled')])).toBe(true);
    expect(isPdfNotebook([written('ruled'), written('blank')])).toBe(false);
  });

  it('after a PDF page: its size, blank until a page has been written on', () => {
    expect(newPageAfter([pdf(0, 400, 600), pdf(1)], 0)).toEqual({ size: { w: 400, h: 600 } });
  });

  it("after a PDF page: the nearest written page's paper (so 'Apply to all pages' carries over)", () => {
    const pages = [pdf(0), written('ruled', 'cream'), pdf(1, 500, 700), pdf(2), written('grid')];
    expect(newPageAfter(pages, 2)).toEqual({ size: { w: 500, h: 700 }, paper: 'ruled', paperColor: 'cream' });
    expect(newPageAfter(pages, 3)).toEqual({ size: { w: 612, h: 792 }, paper: 'grid', paperColor: 'white' });
    expect(newPageAfter(pages, 0)).toEqual({ size: { w: 612, h: 792 }, paper: 'ruled', paperColor: 'cream' });
  });

  it('after a written page: continues it, as before', () => {
    expect(newPageAfter([pdf(0), written('grid', 'cream')], 1)).toEqual({ size: { w: 595, h: 842 }, paper: 'grid', paperColor: 'cream' });
    expect(newPageAfter([], 0)).toEqual({});
  });
});
