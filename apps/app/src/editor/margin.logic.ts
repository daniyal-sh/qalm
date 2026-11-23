/**
 * Where margin comment cards go: one tidy column hugging the page's right edge, inside the gutter beside the page.
 * Only when the comments panel is closed (open, the panel lists every thread and the page keeps just its pins) and
 * only when the gutter is wide enough; otherwise pins on the page and the panel do the job.
 */

/** px between the page's right edge and the card column. */
export const MARGIN_GAP = 16;
/** px kept clear between the column and the scroller's right edge (its scrollbar). */
export const MARGIN_EDGE = 24;
export const MARGIN_MIN_W = 160;
export const MARGIN_MAX_W = 248;
/** px height of the "+N more" chip under a full column. */
export const MARGIN_MORE_H = 32;

export interface MarginColumn {
  /** px from the page's right edge to the column's left edge */
  gap: number;
  /** px width of the cards */
  width: number;
}

/**
 * The card column beside pages `pageW` px wide (the widest page, so every page's cards are the same width), centred in
 * a scroller `contentW` px wide; null when the panel is open or the column wouldn't fit.
 */
export function marginColumn(contentW: number, pageW: number, panelOpen: boolean): MarginColumn | null {
  if (panelOpen) return null;
  const gutter = (contentW - pageW) / 2;
  const width = Math.floor(Math.min(MARGIN_MAX_W, gutter - MARGIN_GAP - MARGIN_EDGE));
  return width >= MARGIN_MIN_W ? { gap: MARGIN_GAP, width } : null;
}

/**
 * The cards (placed top to bottom, `top` px within the page, as `marginCards` returns them) that fit beside a page
 * `pageH` px tall. When they don't all fit, the column ends with a "+N more" chip (`MARGIN_MORE_H`) instead of running
 * past the page onto the next one's cards; `more` is how many were left to the panel and `moreTop` where the chip goes.
 */
export function fitColumn<T extends { top: number }>(cards: readonly T[], cardH: number, gap: number, pageH: number): { shown: T[]; more: number; moreTop: number } {
  const last = cards[cards.length - 1];
  if (!last || last.top + cardH <= pageH) return { shown: [...cards], more: 0, moreTop: 0 };
  let k = 0;
  while (k < cards.length && cards[k]!.top + cardH + gap + MARGIN_MORE_H <= pageH) k++;
  const moreTop = k ? cards[k - 1]!.top + cardH + gap : Math.max(0, Math.min(cards[0]!.top, pageH - MARGIN_MORE_H));
  return { shown: cards.slice(0, k), more: cards.length - k, moreTop };
}

/** px between stacked margin cards. */
export const MARGIN_CARD_GAP = 8;
