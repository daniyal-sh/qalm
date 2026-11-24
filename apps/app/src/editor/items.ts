import { newIdFallback } from '../lib/id';
import type { CrossPageUndo } from './undoStack';
import { adjustShape, detectScribble, emptyPlan, frameBBox, hitTestErase, planPartialErase, inkOnPaper, recognizeShape, shapePolylines, type ShapeItem, type ShapeKind, itemDistance, moveBy, selectionFrame, swatchOfInk, transformItem, type BBox, type InkPoint, type Item, type Page, type PaperColor, type PenStyle, type Smoothing, type StrokeItem, type TextItem } from '@qalm/core';

/** Text box line height (matches core's TEXT_LINE_HEIGHT). */
export const TEXT_LINE_HEIGHT = 1.3;
export const DEFAULT_TEXT_SIZE = 16;
export const DEFAULT_TEXT_WIDTH = 260;

export function pointsBBox(points: readonly { x: number; y: number }[], pad = 0): BBox {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of points) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  if (!Number.isFinite(x0)) return [0, 0, 0, 0];
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
}

export function unionBBox(boxes: BBox[]): BBox | null {
  if (!boxes.length) return null;
  let [x0, y0, x1, y1] = boxes[0]!;
  for (const b of boxes) {
    x0 = Math.min(x0, b[0]);
    y0 = Math.min(y0, b[1]);
    x1 = Math.max(x1, b[2]);
    y1 = Math.max(y1, b[3]);
  }
  return [x0, y0, x1, y1];
}

export function makeStroke(e: {
  id: string;
  tool: 'pen' | 'highlighter';
  color: string;
  width: number;
  points: InkPoint[];
  style?: PenStyle;
  smoothing?: Smoothing;
}): StrokeItem {
  return {
    id: e.id,
    type: 'stroke',
    tool: e.tool,
    color: e.color,
    width: e.width,
    points: e.points,
    bbox: pointsBBox(e.points, e.width / 2),
    createdAt: Date.now(),
    // Pen strokes keep the style and smoothing they were drawn with, so later default changes never alter them.
    ...(e.tool === 'pen' ? { style: e.style ?? 'fountain', smoothing: e.smoothing ?? 0 } : null),
  };
}

/** A shape recognised while the pen is down, with its outline (qalm-ink's `ShapePreview`). */
export interface LiveShape {
  kind: string;
  pts: [number, number][];
  polylines: [number, number][][];
}

const preview = (kind: ShapeKind, pts: [number, number][]): LiveShape => ({ kind, pts, polylines: shapePolylines({ kind, pts }) });

/** The overlay's `recognizeShape`: core's recogniser, no hold gate (the overlay timed the hold). */
export function liveShape(points: { x: number; y: number }[]): LiveShape | null {
  const s = recognizeShape(points);
  return s ? preview(s.kind, s.pts) : null;
}

/** The overlay's `adjustShape` (web): the shape for the pen at `to`, having snapped with the pen at `from`. */
export function adjustLiveShape(shape: LiveShape, from: [number, number], to: [number, number]): LiveShape {
  return preview(shape.kind as ShapeKind, adjustShape({ kind: shape.kind as ShapeKind, pts: shape.pts }, from, to));
}

/**
 * Stores a stroke that snapped to a shape while held: first the stroke as drawn, then the shape in its place (same
 * id, so the overlay hands off without a flicker). Two transactions, so two undo steps: one undo brings the
 * hand-drawn stroke back, a second removes it.
 */
export function commitSnapped(page: Page, stroke: StrokeItem, shape: { kind: string; pts: [number, number][] }): void {
  page.addItem(stroke);
  const item: ShapeItem = { id: stroke.id, type: 'shape', kind: shape.kind as ShapeKind, pts: shape.pts, color: stroke.color, width: stroke.width };
  page.addItem(item);
}

/** The eraser: rubs out whole strokes, or only where it passes (strokes split into pieces, shapes erased whole). */
export type EraserMode = 'stroke' | 'partial';

/**
 * One eraser segment (the overlay's onErase). Every segment of one gesture joins one undo entry, so one undo brings
 * back everything the gesture erased (a split stroke as it was). Returns whether anything changed.
 */
export function eraseAlong(
  page: Page,
  undo: Pick<CrossPageUndo, 'merging'>,
  path: { x: number; y: number }[],
  radius: number,
  mode: EraserMode,
  makeId: () => string = newIdFallback,
  /** Collects the strokes left with a cut, for `bakeErase` when the gesture ends. */
  cut?: Set<string>,
): boolean {
  if (mode === 'partial') {
    const plan = planPartialErase(page.items(), path, radius, makeId);
    if (emptyPlan(plan)) return false;
    undo.merging('erase', () => page.applyErase(plan));
    if (cut) for (const s of plan.split) if (s.keep) cut.add(s.id);
    return true;
  }
  const ids = hitTestErase(page.items(), path, radius);
  if (!ids.length) return false;
  undo.merging('erase', () => page.removeItems(ids));
  return true;
}

/**
 * The end of a partial-erase gesture: the strokes it left with a cut get their kept points written once (`bakeCuts`),
 * in the gesture's undo step, so one undo still restores everything and readers without cuts see the right ink.
 */
export function bakeErase(page: Page, undo: Pick<CrossPageUndo, 'merging'>, cut: Set<string>): void {
  if (!cut.size) return;
  const ids = [...cut];
  cut.clear();
  undo.merging('erase', () => page.bakeCuts(ids));
}

/**
 * Scribble to erase: a pen stroke that is a quick zig-zag over ink deletes that ink (one undo step) and is not kept.
 * Returns the deleted items (for the fade), or null when the stroke is ink to keep.
 */
export function scribbleErase(page: Page, points: InkPoint[], width: number): Item[] | null {
  const ids = detectScribble(page.items(), points, width);
  if (!ids) return null;
  const gone = ids.map((id) => page.item(id)).filter((it): it is Item => !!it);
  page.removeItems(ids);
  return gone;
}

/** Selection transforms live in core (move, uniform scale and rotation about an origin). */
export { IDENTITY, itemBBox, moveBy, transformItem, transformPatch, type Sim } from '@qalm/core';

/** The page-space box of a selection, with room for the ink (what Ask / Comment on a selection send). */
export function selectionBBox(items: readonly Item[]): BBox | null {
  const f = selectionFrame(items);
  return f ? frameBBox(f) : null;
}

/** Can the item be recoloured? Images and highlighters keep their colour. */
export function recolorable(it: Item): it is Exclude<Item, { type: 'image' }> {
  return it.type !== 'image' && !(it.type === 'stroke' && it.tool === 'highlighter');
}

/**
 * Recolours strokes, shapes and text to swatch `color` on a page of `paper`: like new ink, graphite turns light on
 * night paper. Images and highlighters keep their colour.
 */
export function recolorPatch(it: Item, color: string, paper?: PaperColor): Partial<Item> | null {
  if (!recolorable(it)) return null;
  return { color: inkOnPaper(color, paper) } as Partial<Item>;
}

/** The swatch the selection's ink uses when it all shares one (ticked in the recolour strip), else null. */
export function selectionSwatch(items: readonly Item[], paper?: PaperColor): string | null {
  const cs = new Set(items.filter(recolorable).map((it) => swatchOfInk(it.color.toLowerCase(), paper)));
  return cs.size === 1 ? [...cs][0]! : null;
}

const textUndoKey = (id: string) => `text:${id}`;

/**
 * Typing into a text box. A new box (`draft`) is added by its first non-blank character; it and the typing that
 * follows (pauses under 2 s) are one undo step. Returns true when the box is on the page.
 */
export function typeText(page: Page, undo: Pick<CrossPageUndo, 'merging'>, id: string, text: string, draft?: TextItem): boolean {
  return undo.merging(
    textUndoKey(id),
    () => {
      if (page.item(id)) page.updateItem(id, { text } as Partial<TextItem>);
      else if (draft && text.trim()) page.addItem({ ...draft, text });
      else return false;
      return true;
    },
    2000,
  );
}

/**
 * Removes a text box left empty. The removal joins the box's last typing step (however old), so one undo restores the
 * box as it was before that typing: not at all when that typing created it. Returns true if it removed the box.
 */
export function dropEmptyText(page: Page, undo: Pick<CrossPageUndo, 'merging'>, id: string): boolean {
  const it = page.item(id);
  if (it?.type !== 'text' || it.text.trim()) return false;
  undo.merging(textUndoKey(id), () => page.removeItems([id]), Number.POSITIVE_INFINITY);
  return true;
}

/** Copies of items with fresh ids, offset by (dx, dy). */
export function cloneItems(items: Item[], dx: number, dy: number, newId: () => string = newIdFallback): Item[] {
  return items.map((it) => {
    const copy = { ...transformItem(it, moveBy(dx, dy)), id: newId() } as Item & { splitFrom?: string };
    delete copy.splitFrom; // a copy is new ink, not a piece of anything
    return copy as Item;
  });
}

/** The topmost text box under (x, y), turned ones too. */
export function hitText(items: Item[], x: number, y: number): TextItem | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.type === 'text' && itemDistance(it, [x, y]) === 0) return it;
  }
  return null;
}
