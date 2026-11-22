import * as Y from 'yjs';
import { Page, createNotebookDoc, Notebook } from '../src';
import type { InkPoint, StrokeItem } from '../src';

/** Points along a polyline, upright pen, 10 points per segment. */
export function pts(...xy: [number, number][]): InkPoint[] {
  const out: InkPoint[] = [];
  for (let i = 0; i < xy.length - 1; i++) {
    const [a, b] = [xy[i]!, xy[i + 1]!];
    for (let k = 0; k < 10; k++) {
      const t = k / 10;
      out.push({ x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t, p: 0.5, tilt: Math.PI / 2, az: 0, t: out.length * 8 });
    }
  }
  const z = xy[xy.length - 1]!;
  out.push({ x: z[0], y: z[1], p: 0.5, tilt: Math.PI / 2, az: 0, t: out.length * 8 });
  return out;
}

/** A pen stroke whose bbox is exactly [x0, y0, x1, y1] (a diagonal). */
export function stroke(id: string, x0: number, y0: number, x1: number, y1: number, extra: Partial<StrokeItem> = {}): StrokeItem {
  return { id, type: 'stroke', tool: 'pen', color: '#27272a', width: 1.8, points: pts([x0, y0], [x1, y1]), bbox: [x0, y0, x1, y1], createdAt: 0, ...extra };
}

export function newPage(): Page {
  return new Page(new Y.Doc());
}

export function newNotebook(): Notebook {
  return new Notebook(createNotebookDoc({ id: 'nb1', title: 'Calculus', cover: '#4338ca', paper: 'ruled', paperColor: 'white', size: { w: 595, h: 842 } }));
}

/** Two-way sync of two docs. */
export function sync(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)), 'remote');
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)), 'remote');
}
