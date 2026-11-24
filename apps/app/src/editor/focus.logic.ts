// Fullscreen focus layout (pure): which panels close and come back, where the floating tool pill sits, and which
// keys toggle fullscreen. The platform side is in lib/fullscreen(.web).ts.

/** The editor's side panels. */
export interface Panels {
  nav: boolean;
  comments: boolean;
}

/** Entering focus closes both panels and remembers how they were, for leaving. */
export function enterFocus(p: Panels): { panels: Panels; saved: Panels } {
  return { panels: { nav: false, comments: false }, saved: { ...p } };
}

/** Leaving focus restores the panels as they were before it (or keeps the current ones if nothing was saved). */
export function leaveFocus(saved: Panels | null, current: Panels): Panels {
  return saved ? { ...saved } : current;
}

// ---- the pill ----

export type Edge = 'top' | 'bottom' | 'left' | 'right';
/** The pill's place: the window edge it sits on, and its centre along that edge (0 = start, 1 = end). */
export interface PillPlace {
  edge: Edge;
  along: number;
}
export const DEFAULT_PILL: PillPlace = { edge: 'top', along: 0.5 };
/** Gap between the pill and the window edge (and the other edges it is clamped from). */
export const PILL_MARGIN = 12;

const EDGES: readonly Edge[] = ['top', 'bottom', 'left', 'right'];
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/** A stored place, checked (local prefs can hold anything). */
export function parsePill(raw: unknown): PillPlace {
  const r = raw as Partial<PillPlace> | null;
  if (!r || typeof r !== 'object' || !EDGES.includes(r.edge as Edge) || typeof r.along !== 'number' || !Number.isFinite(r.along)) return DEFAULT_PILL;
  return { edge: r.edge as Edge, along: clamp(r.along, 0, 1) };
}

export const isVertical = (edge: Edge) => edge === 'left' || edge === 'right';

export interface Size {
  w: number;
  h: number;
}
/** Extra room to keep clear at each window edge (safe-area insets). */
export interface Pad {
  top: number;
  right: number;
  bottom: number;
  left: number;
}
const NO_PAD: Pad = { top: 0, right: 0, bottom: 0, left: 0 };

/** Top-left of a pill of size `pill` at `place` in a `view`, kept fully inside it. */
export function pillOrigin(place: PillPlace, view: Size, pill: Size, pad: Pad = NO_PAD): { left: number; top: number } {
  const m = PILL_MARGIN;
  const minL = m + pad.left;
  const maxL = view.w - pill.w - m - pad.right;
  const minT = m + pad.top;
  const maxT = view.h - pill.h - m - pad.bottom;
  if (isVertical(place.edge)) {
    const top = clamp(place.along * view.h - pill.h / 2, minT, maxT);
    return { left: place.edge === 'left' ? minL : Math.max(minL, maxL), top };
  }
  const left = clamp(place.along * view.w - pill.w / 2, minL, maxL);
  return { left, top: place.edge === 'top' ? minT : Math.max(minT, maxT) };
}

/** Smallest scale the pill shrinks to on narrow screens (its 44 px buttons stay about 36 px: still easy to tap). */
export const PILL_MIN_SCALE = 0.8;

/**
 * How much the pill shrinks to fit along its edge: 1 when it fits, down to PILL_MIN_SCALE on a phone. Without this a
 * top or bottom pill ran past the right edge of a portrait phone and cut off the exit button.
 */
export function pillScale(place: PillPlace, view: Size, pill: Size, pad: Pad = NO_PAD): number {
  const along = isVertical(place.edge) ? pill.h : pill.w;
  const room = isVertical(place.edge) ? view.h - pad.top - pad.bottom : view.w - pad.left - pad.right;
  if (along <= 0) return 1;
  return Math.max(PILL_MIN_SCALE, Math.min(1, (room - 2 * PILL_MARGIN) / along));
}

/** Where a pill dropped with its centre at (x, y) goes: the nearest edge, at that point along it. */
export function snapPill(x: number, y: number, view: Size): PillPlace {
  const w = Math.max(1, view.w);
  const h = Math.max(1, view.h);
  const d: Record<Edge, number> = { top: y, bottom: h - y, left: x, right: w - x };
  const edge = EDGES.reduce((best, e) => (d[e] < d[best] ? e : best), 'top' as Edge);
  return { edge, along: clamp(isVertical(edge) ? y / h : x / w, 0, 1) };
}

// ---- keys ----

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * The fullscreen shortcut: F11 (Windows, Linux, browsers) or Ctrl+Cmd+F (macOS). Esc is handled by the editor, after
 * it clears a selection.
 */
export function isFullscreenKey(ev: KeyLike): boolean {
  if (ev.key === 'F11') return !ev.ctrlKey && !ev.metaKey && !ev.altKey;
  return ev.ctrlKey && ev.metaKey && !ev.altKey && ev.key.toLowerCase() === 'f';
}

/** The shortcut's name for tooltips. */
export const fullscreenShortcut = (mac: boolean) => (mac ? '⌃⌘F' : 'F11');
