import { describe, expect, it } from 'vitest';
import {
  applySim,
  boxSelect,
  createUndoManager,
  frameCorners,
  hitTestPoint,
  itemBBox,
  LOCAL_ORIGIN,
  mapFrame,
  resizeSim,
  rotateSim,
  selectionFrame,
  shapePolylines,
  simMatrix,
  textWidthPatch,
  transformItem,
  transformPatch,
  visualBBox,
  type ImageItem,
  type Item,
  type ShapeItem,
  type TextItem,
} from '../src';
import { newPage, stroke } from './helpers';

const close = (a: number[], b: number[], eps = 1e-6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, -Math.log10(eps)));

const text = (extra: Partial<TextItem> = {}): TextItem => ({ id: 't', type: 'text', x: 100, y: 100, w: 200, text: 'hello', fontSize: 16, color: '#000', ...extra });
const image = (extra: Partial<ImageItem> = {}): ImageItem => ({ id: 'im', type: 'image', assetId: 'a', x: 10, y: 20, w: 100, h: 50, ...extra });
const rect = (id: string, x0: number, y0: number, x1: number, y1: number): ShapeItem => ({
  id,
  type: 'shape',
  kind: 'rect',
  pts: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
  color: '#000',
  width: 2,
});

describe('similarity transforms', () => {
  it('moves, scales and rotates points, and its matrix agrees', () => {
    const f = { s: 2, r: Math.PI / 2, ox: 10, oy: 10, dx: 5, dy: 0 };
    close(applySim(20, 10, f), [15, 30]); // (10,0) → scaled (20,0) → turned (0,20) → +o +d
    const [a, b, c, d, e, g] = simMatrix(f);
    close([a * 20 + c * 10 + e, b * 20 + d * 10 + g], [15, 30]);
  });

  it('scales stroke width and points; recomputes the bbox', () => {
    const s = stroke('a', 0, 0, 10, 10);
    const t = transformItem(s, { s: 2, r: 0, ox: 0, oy: 0, dx: 1, dy: 1 });
    expect(t.width).toBeCloseTo(3.6);
    close(t.bbox, [1 - 1.8, 1 - 1.8, 21 + 1.8, 21 + 1.8]);
    expect(transformPatch(s, { s: 1, r: 0, ox: 0, oy: 0, dx: 5, dy: 0 })).toMatchObject({ width: 1.8, bbox: [5 - 0.9, -0.9, 15.9, 10.9] });
  });

  it('turns text boxes and images about their top-left corner, keeping image aspect', () => {
    const im = transformItem(image(), { s: 1.5, r: Math.PI / 6, ox: 10, oy: 20, dx: 0, dy: 0 });
    expect(im).toMatchObject({ x: 10, y: 20, w: 150, h: 75 });
    expect(im.rot).toBeCloseTo(Math.PI / 6);
    const back = transformItem(im, { s: 1, r: -Math.PI / 6, ox: 10, oy: 20, dx: 0, dy: 0 });
    expect(back.rot).toBeUndefined();
    expect(transformPatch(text({ rot: 0.3 }), { s: 1, r: -0.3, ox: 0, oy: 0, dx: 0, dy: 0 })).toHaveProperty('rot', undefined);
    const tx = transformItem(text(), { s: 2, r: 0, ox: 100, oy: 100, dx: 0, dy: 0 });
    expect(tx).toMatchObject({ w: 400, fontSize: 32 });
  });

  it('turns older 2-point rects and ellipses into 4 corners so they can rotate', () => {
    const e: ShapeItem = { id: 'e', type: 'shape', kind: 'ellipse', pts: [[0, 0], [40, 20]], color: '#000', width: 2 };
    const r = transformItem(e, { s: 1, r: Math.PI / 2, ox: 20, oy: 10, dx: 0, dy: 0 });
    expect(r.pts).toHaveLength(4);
    // A 40×20 ellipse turned a quarter: 20 wide, 40 tall, same centre.
    close(itemBBox(r), [10 - 1, -10 - 1, 30 + 1, 30 + 1]);
    const pl = shapePolylines(r)[0]!;
    const xs = pl.map((p) => p[0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(20, 1);
  });
});

describe('selection frame', () => {
  it('is the upright box around the ink, with room for wide strokes', () => {
    const f = selectionFrame([stroke('a', 0, 0, 10, 10), rect('r', 50, 50, 60, 70)])!;
    expect(f.rot).toBe(0);
    const vb = visualBBox(stroke('a', 0, 0, 10, 10));
    expect(vb[0]).toBeLessThan(0);
    expect(f.cx - f.w / 2).toBeCloseTo(vb[0]);
    expect(f.cy + f.h / 2).toBeCloseTo(71.5);
  });

  it('turns with a single turned image or text box', () => {
    const im = image({ rot: Math.PI / 2 });
    const f = selectionFrame([im])!;
    expect(f).toMatchObject({ w: 100, h: 50 });
    expect(f.rot).toBeCloseTo(Math.PI / 2);
    // Its corners are the image's corners.
    close(frameCorners(f)[0]!, [10, 20]);
    close(frameCorners(f)[1]!, [10, 120]);
  });

  it('a corner handle scales uniformly about the opposite corner, never below the minimum', () => {
    const f = { cx: 50, cy: 50, w: 100, h: 50, rot: 0 }; // corners (0,25) (100,25) (100,75) (0,75)
    const s = resizeSim(f, 2, [200, 90]);
    expect(s).toMatchObject({ ox: 0, oy: 25 });
    // Projected onto the diagonal: (200·100 + 65·50) / (100² + 50²) = 1.86
    expect(s.s).toBeCloseTo(1.86);
    expect(resizeSim(f, 2, [-500, -500]).s).toBeCloseTo(4 / 50);
    const m = mapFrame(f, s);
    expect(m.w).toBeCloseTo(186);
    close(frameCorners(m)[0]!, [0, 25]);
  });

  it('the rotate handle turns about the centre and snaps to 45°', () => {
    const f = { cx: 0, cy: 0, w: 10, h: 10, rot: 0 };
    expect(rotateSim(f, [0, -10], [10, 0]).r).toBeCloseTo(Math.PI / 2);
    expect(rotateSim(f, [0, -10], [Math.sin(0.03) * 10, -Math.cos(0.03) * 10]).r).toBe(0); // 1.7° → snapped back
    expect(rotateSim(f, [0, -10], [Math.sin(0.3) * 10, -Math.cos(0.3) * 10]).r).toBeCloseTo(0.3);
  });

  it('a text box edge changes only its width, along its own direction', () => {
    expect(textWidthPatch(text(), 'right', [250, 140])).toEqual({ x: 100, y: 100, w: 150 });
    expect(textWidthPatch(text(), 'left', [150, 0])).toEqual({ x: 150, y: 100, w: 150 });
    expect(textWidthPatch(text(), 'right', [0, 0]).w).toBe(24);
    const turned = textWidthPatch(text({ rot: Math.PI / 2 }), 'right', [90, 180]);
    close([turned.x, turned.y, turned.w], [100, 100, 80]);
  });

  it('a narrower text box wraps into more rows', () => {
    const t = text({ text: 'one two three four five six', w: 400 });
    const h1 = itemBBox(t)[3] - itemBBox(t)[1];
    const h2 = itemBBox({ ...t, w: 60 })[3] - itemBBox({ ...t, w: 60 })[1];
    expect(h2).toBeGreaterThan(h1 * 2);
  });
});

describe('tap and box select', () => {
  const items: Item[] = [image({ x: 0, y: 0, w: 300, h: 300 }), stroke('s', 50, 50, 150, 50), text({ x: 200, y: 200, w: 80 }), rect('r', 400, 400, 500, 500)];

  it('picks the nearest item within tolerance, topmost on a tie', () => {
    expect(hitTestPoint(items, { x: 100, y: 52 }, 4)).toBe('s'); // on the stroke, over the image
    expect(hitTestPoint(items, { x: 100, y: 120 }, 4)).toBe('im'); // only the image
    expect(hitTestPoint(items, { x: 210, y: 205 }, 4)).toBe('t'); // text on top of the image
    expect(hitTestPoint(items, { x: 600, y: 600 }, 4)).toBeNull();
  });

  it('selects a shape by its outline or inside it', () => {
    expect(hitTestPoint(items, { x: 403, y: 450 }, 4)).toBe('r');
    expect(hitTestPoint(items, { x: 450, y: 450 }, 4)).toBe('r');
    expect(hitTestPoint(items, { x: 520, y: 450 }, 4)).toBeNull();
  });

  it('hits a turned image only inside its turned box', () => {
    const im = image({ x: 100, y: 100, w: 100, h: 20, rot: Math.PI / 2 }); // now spans x 80..100, y 100..200
    expect(hitTestPoint([im], { x: 90, y: 190 }, 2)).toBe('im');
    expect(hitTestPoint([im], { x: 150, y: 110 }, 2)).toBeNull();
  });

  it('box select takes what is mostly inside, in either drag direction', () => {
    expect(boxSelect(items, { x: 160, y: 40 }, { x: 40, y: 60 })).toEqual(['s']);
    expect(boxSelect(items, { x: 190, y: 190 }, { x: 600, y: 600 }).sort()).toEqual(['r', 't']);
    expect(boxSelect(items, { x: 1, y: 1 }, { x: 1, y: 1 })).toEqual([]);
  });
});

describe('editing a page', () => {
  it('moves, rotates and reorders as single undo steps, keeping line assignment right', () => {
    const page = newPage();
    page.addItem(stroke('a', 50, 100, 60, 120));
    page.addItem(stroke('b', 62, 100, 70, 120));
    page.addItem(stroke('z', 50, 300, 60, 320));
    const um = createUndoManager(page);
    // Move b onto z's row and turn it a little: it leaves a's line and joins z's.
    page.doc.transact(() => {
      const b = page.item('b')!;
      page.updateItem('b', transformPatch(b, { s: 1, r: 0.1, ox: 66, oy: 110, dx: 0, dy: 200 }));
    }, LOCAL_ORIGIN);
    expect(page.lines().map((l) => l.key)).toEqual(['a', 'z']);
    expect(page.lines()[0]!.itemIds).toEqual(['a']);
    expect(new Set(page.lines().find((l) => l.key === 'z')!.itemIds)).toEqual(new Set(['b', 'z']));
    page.reorder(['a'], 'front');
    expect(page.items().map((i) => i.id)).toEqual(['b', 'z', 'a']);
    page.reorder(['a', 'z'], 'back');
    expect(page.items().map((i) => i.id)).toEqual(['z', 'a', 'b']);
    um.undo();
    um.undo();
    expect(page.items().map((i) => i.id)).toEqual(['a', 'b', 'z']);
    um.undo();
    expect(page.lines().map((l) => [l.key, l.itemIds])).toEqual([
      ['a', ['a', 'b']],
      ['z', ['z']],
    ]);
  });

  it('a moved selection thread stays on its line key when its whole line moves', () => {
    const page = newPage();
    page.addItem(stroke('a', 50, 100, 60, 120));
    page.addItem(stroke('b', 62, 100, 70, 120));
    page.doc.transact(() => {
      for (const id of ['a', 'b']) page.updateItem(id, transformPatch(page.item(id)!, { s: 1.5, r: 0, ox: 50, oy: 100, dx: 0, dy: 300 }));
    }, LOCAL_ORIGIN);
    expect(page.lines().map((l) => [l.key, l.itemIds])).toEqual([['a', ['a', 'b']]]);
  });
});
