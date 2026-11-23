import { describe, expect, it } from 'vitest';

import { fitColumn, MARGIN_EDGE, MARGIN_GAP, MARGIN_MAX_W, MARGIN_MIN_W, MARGIN_MORE_H, marginColumn } from '../src/editor/margin.logic';
import { NAV_RING, navLayout, thumbBox } from '../src/editor/navigator.logic';
import { scrollbarCss } from '../src/theme/scrollbars';

describe('margin card column', () => {
  it('is hidden while the comments panel is open', () => {
    expect(marginColumn(1600, 900, true)).toBeNull();
    expect(marginColumn(1600, 900, false)).not.toBeNull();
  });

  it('hugs the page edge, capped in width, and clear of the scroller edge', () => {
    const col = marginColumn(1600, 900, false)!;
    expect(col.gap).toBe(MARGIN_GAP);
    expect(col.width).toBe(MARGIN_MAX_W);
    // A narrower gutter: the column shrinks but keeps MARGIN_EDGE clear on the right.
    const gutter = 220;
    const narrow = marginColumn(900 + gutter * 2, 900, false)!;
    expect(narrow.width).toBe(gutter - MARGIN_GAP - MARGIN_EDGE);
    expect(MARGIN_GAP + narrow.width + MARGIN_EDGE).toBeLessThanOrEqual(gutter);
  });

  it('gives up when the gutter is too narrow (zoomed in, small windows)', () => {
    const minGutter = MARGIN_MIN_W + MARGIN_GAP + MARGIN_EDGE;
    expect(marginColumn(900 + (minGutter - 1) * 2, 900, false)).toBeNull();
    expect(marginColumn(900 + minGutter * 2, 900, false)).not.toBeNull();
    // Zoomed past the viewport: the scroller is only the page plus 48 px.
    expect(marginColumn(1848, 1800, false)).toBeNull();
  });
});

describe('fitColumn', () => {
  const at = (...tops: number[]) => tops.map((top) => ({ top }));

  it('keeps every card when they fit beside the page', () => {
    expect(fitColumn(at(0, 72, 144), 64, 8, 800)).toEqual({ shown: at(0, 72, 144), more: 0, moreTop: 0 });
    expect(fitColumn([], 64, 8, 800).shown).toEqual([]);
  });

  it('ends a full column with a "+N more" chip that stays on the page and never overlaps a card', () => {
    const cards = at(0, 72, 144, 216, 288);
    const { shown, more, moreTop } = fitColumn(cards, 64, 8, 300);
    expect(shown.length + more).toBe(cards.length);
    expect(more).toBeGreaterThan(0);
    const lastBottom = shown.length ? shown[shown.length - 1]!.top + 64 : 0;
    expect(moreTop).toBeGreaterThanOrEqual(lastBottom);
    expect(moreTop + MARGIN_MORE_H).toBeLessThanOrEqual(300);
  });

  it('shows only the chip when not even one card fits', () => {
    const r = fitColumn(at(40), 64, 8, 60);
    expect(r.shown).toEqual([]);
    expect(r.more).toBe(1);
    expect(r.moreTop + MARGIN_MORE_H).toBeLessThanOrEqual(60);
  });
});

describe('page thumbnails', () => {
  const a4 = { w: 595, h: 842 };
  it('fit the page aspect inside the cell, leaving room for the ring', () => {
    const layout = navLayout(224, 'sidebar', [{ size: a4 }]);
    const b = thumbBox(a4, layout);
    expect(b.w).toBeLessThanOrEqual(layout.cellW - NAV_RING * 2);
    expect(b.h).toBeLessThanOrEqual(layout.thumbH - NAV_RING * 2);
    expect(Math.abs(b.h / b.w - a4.h / a4.w)).toBeLessThan(0.02);
  });

  it('never crop a landscape or tall page in a row sized for another', () => {
    const land = { w: 842, h: 595 };
    const tall = { w: 400, h: 1200 };
    const layout = navLayout(224, 'sidebar', [{ size: a4 }, { size: land }]);
    for (const s of [land, tall]) {
      const b = thumbBox(s, layout);
      expect(b.w).toBeLessThanOrEqual(layout.cellW - NAV_RING * 2);
      expect(b.h).toBeLessThanOrEqual(layout.thumbH - NAV_RING * 2);
      expect(Math.abs(b.h / b.w - s.h / s.w)).toBeLessThan(0.03);
    }
  });
});

describe('web scrollbars', () => {
  it('are thin, with a transparent track, and follow the theme', () => {
    const d = scrollbarCss('dark', { muted: '#a1a1aa' });
    expect(d).toContain('color-scheme: dark');
    expect(d).toContain('scrollbar-width: thin');
    expect(d).toContain('scrollbar-color: transparent transparent');
    expect(scrollbarCss('light', { muted: '#5c5c65' })).toContain('color-scheme: light');
    expect(d).not.toMatch(/gradient|blur/);
  });
});
