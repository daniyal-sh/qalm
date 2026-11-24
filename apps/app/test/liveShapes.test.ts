import { createUndoManager, Page, type InkPoint } from '@qalm/core';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { adjustLiveShape, commitSnapped, liveShape, makeStroke } from '../src/editor/items';
import { CrossPageUndo } from '../src/editor/undoStack';
import { stroke } from './helpers';

/** A hand-drawn circle (radius 60 about 200, 200), a little past its start. */
function circleStroke(): ReturnType<typeof makeStroke> {
  const points: InkPoint[] = Array.from({ length: 70 }, (_, i) => {
    const a = (i / 64) * 2 * Math.PI;
    const r = 60 + Math.sin(i / 5) * 1.5;
    return { x: 200 + r * Math.cos(a), y: 200 + r * Math.sin(a), p: 0.5, tilt: Math.PI / 2, az: 0, t: i * 8 };
  });
  return makeStroke({ id: 'c1', tool: 'pen', color: '#1d4ed8', width: 2.4, points, style: 'ball', smoothing: 1 });
}

function setup() {
  const undo = new CrossPageUndo(() => 0);
  const page = new Page(new Y.Doc());
  undo.attach('p', createUndoManager(page));
  return { undo, page };
}

describe('live shapes in the app', () => {
  it('recognises a held circle and gives the overlay its outline; dragging scales it', () => {
    const s = circleStroke();
    const shape = liveShape(s.points)!;
    expect(shape.kind).toBe('ellipse');
    expect(shape.polylines[0]!.length).toBeGreaterThan(30);
    const from: [number, number] = [s.points.at(-1)!.x, s.points.at(-1)!.y];
    const bigger = adjustLiveShape(shape, from, [200 + (from[0] - 200) * 1.5, 200 + (from[1] - 200) * 1.5]);
    expect(bigger.kind).toBe('ellipse');
    const w = (pts: [number, number][]) => Math.hypot(pts[1]![0] - pts[0]![0], pts[1]![1] - pts[0]![1]);
    expect(w(bigger.pts) / w(shape.pts)).toBeCloseTo(1.5, 1);
    expect(liveShape([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toBeNull();
  });

  it('a snapped stroke is one shape; one undo brings the hand-drawn stroke back, redo the shape', () => {
    const { undo, page } = setup();
    const before = stroke(0, 400, 100, 400);
    page.addItem(before);
    const s = circleStroke();
    const shape = liveShape(s.points)!;
    commitSnapped(page, s, shape);

    const items = page.items();
    expect(items).toHaveLength(2);
    const it = page.item('c1')!;
    expect(it.type).toBe('shape');
    expect(it).toMatchObject({ kind: 'ellipse', color: '#1d4ed8', width: 2.4, pts: shape.pts });

    expect(undo.undo()).toBe('p');
    const back = page.item('c1')!;
    expect(back.type).toBe('stroke');
    expect(back).toMatchObject({ color: '#1d4ed8', width: 2.4, style: 'ball', smoothing: 1 });
    expect(back.type === 'stroke' && back.points).toHaveLength(s.points.length);
    expect(page.items().map((i) => i.id)).toEqual([before.id, 'c1']);

    expect(undo.redo()).toBe('p');
    expect(page.item('c1')!.type).toBe('shape');
    expect(page.items()).toHaveLength(2);

    // Undo twice: the stroke goes too, and the stroke before it stays.
    undo.undo();
    undo.undo();
    expect(page.items().map((i) => i.id)).toEqual([before.id]);
  });
});
