/** Pure editor view maths: zoom, page layout and virtualization, PDF width buckets, pen-button tool switching. */
import type { BBox, Comment, Line, PageInfo } from '@qalm/core';

export const MIN_ZOOM = 0.75;
export const MAX_ZOOM = 4;
export const PAGE_GAP = 24;

export const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number.isFinite(z) ? z : 1));

/** Zoom steps for the +/- buttons. */
const STEPS = [0.75, 1, 1.25, 1.5, 2, 3, 4];
export function stepZoom(z: number, dir: 1 | -1): number {
  if (dir > 0) return STEPS.find((s) => s > z + 1e-3) ?? MAX_ZOOM;
  return [...STEPS].reverse().find((s) => s < z - 1e-3) ?? MIN_ZOOM;
}

/**
 * The page width at zoom 1: fits the viewport (minus margins), capped so pages don't get huge on
 * desktop monitors.
 */
export function baseWidth(viewportW: number, maxPageW = 900, margin = 24): number {
  return Math.max(200, Math.min(maxPageW, viewportW - margin * 2));
}

/** px width of a page: the widest page in the notebook fills `base × zoom`, others scale with their page size. */
export function pageWidthPx(page: Pick<PageInfo, 'size'>, widestPageW: number, base: number, zoom: number): number {
  return Math.round(base * zoom * (page.size.w / widestPageW));
}

/**
 * The PDF background render width: the nearest bucket (1×, 2× or 4× the zoom-1 width) at or above
 * the displayed width, times the device pixel ratio, so zooming doesn't re-render on every step.
 */
export function pdfBucketWidth(displayW: number, zoom1W: number, pixelRatio = 1): number {
  const ratio = displayW / zoom1W;
  const bucket = ratio <= 1.001 ? 1 : ratio <= 2.001 ? 2 : 4;
  return Math.round(zoom1W * bucket * Math.max(1, Math.min(pixelRatio, 3)));
}

export interface PageSlot {
  id: string;
  top: number;
  width: number;
  height: number;
}

/** Vertical stack of pages (px), with `gap` between them and `pad` above the first. */
export function layoutPages(pages: Pick<PageInfo, 'id' | 'size'>[], base: number, zoom: number, gap = PAGE_GAP, pad = gap): PageSlot[] {
  const widest = Math.max(1, ...pages.map((p) => p.size.w));
  let y = pad;
  return pages.map((p) => {
    const width = pageWidthPx(p, widest, base, zoom);
    const height = Math.round((width * p.size.h) / p.size.w);
    const slot = { id: p.id, top: y, width, height };
    y += height + gap;
    return slot;
  });
}

export function contentHeight(slots: PageSlot[], gap = PAGE_GAP): number {
  const last = slots[slots.length - 1];
  return last ? last.top + last.height + gap : gap;
}

/** Index of the page most in view (largest visible height). */
export function currentPageIndex(slots: PageSlot[], scrollY: number, viewportH: number): number {
  let best = 0;
  let bestH = -Infinity;
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i]!;
    const h = Math.min(s.top + s.height, scrollY + viewportH) - Math.max(s.top, scrollY);
    if (h > bestH) {
      bestH = h;
      best = i;
    }
  }
  return best;
}

/** Pages to mount: those intersecting the viewport, plus `overscan` on each side (tech-spec §2: ±2). */
export function mountedRange(slots: PageSlot[], scrollY: number, viewportH: number, overscan = 2): [number, number] {
  if (!slots.length) return [0, -1];
  let first = slots.findIndex((s) => s.top + s.height >= scrollY);
  if (first < 0) first = slots.length - 1;
  let last = first;
  while (last + 1 < slots.length && slots[last + 1]!.top <= scrollY + viewportH) last++;
  return [Math.max(0, first - overscan), Math.min(slots.length - 1, last + overscan)];
}

/** Scroll offset that keeps the same content point under the viewport centre after a zoom change. */
export function anchoredScroll(prevScroll: number, viewport: number, prevZoom: number, nextZoom: number): number {
  const centre = prevScroll + viewport / 2;
  return Math.max(0, centre * (nextZoom / prevZoom) - viewport / 2);
}

export type ToolId = 'pen' | 'highlighter' | 'eraser' | 'lasso' | 'text';

/** The pen button / squeeze / double-tap (tech-spec §3): toggles the eraser, or swaps back to the previous tool. */
export function penButtonTool(gesture: 'eraser' | 'last' | 'none', tool: ToolId, previous: ToolId): ToolId {
  if (gesture === 'none') return tool;
  if (gesture === 'eraser') return tool === 'eraser' ? (previous === 'eraser' ? 'pen' : previous) : 'eraser';
  return previous;
}

export interface Anchor {
  lineKey: string;
  bbox: BBox;
  active: boolean;
}

/** Comment pins for a page: one per line with an open comment (plus the active comment's line, even if resolved). */
export function commentAnchors(lines: Line[], comments: Comment[], activeCommentId: string | null): Anchor[] {
  const byKey = new Map(lines.map((l) => [l.key, l]));
  const activeKey = comments.find((c) => c.id === activeCommentId)?.lineKey;
  const out = new Map<string, Anchor>();
  for (const c of comments) {
    if (c.resolved && c.id !== activeCommentId) continue;
    const l = byKey.get(c.lineKey);
    if (!l) continue;
    out.set(l.key, { lineKey: l.key, bbox: l.bbox, active: activeKey === l.key });
  }
  return [...out.values()];
}

/** Quote for a comment card: the line's text, if known. */
export function lineQuote(lines: Line[], lineKey: string): string | null {
  const t = lines.find((l) => l.key === lineKey)?.text?.trim();
  return t || null;
}

/** The pin hit target for a tap at page point (x, y), if any (pins sit just right of the line's top-right corner). */
export function hitAnchor(anchors: Anchor[], x: number, y: number, radius = 10): Anchor | null {
  for (const a of anchors) {
    const cx = a.bbox[2] + 9;
    const cy = a.bbox[1] + 5;
    if (Math.hypot(x - cx, y - cy) <= radius) return a;
  }
  return null;
}
