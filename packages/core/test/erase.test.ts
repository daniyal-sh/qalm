import { describe, expect, it } from 'vitest';
import {
  createUndoManager,
  emptyRegions,
  encodeQinkUpdate,
  planPartialErase,
  splitStroke,
  type InkPoint,
  type InkSeen,
  type Item,
  type QinkRegions,
  type StrokeItem,
} from '../src';
import { pointsBBox } from '../src/geometry/bbox';
import { newNotebook, newPage, stroke } from './helpers';
import { handwriting, write } from './ink';

let n = 0;
const ids = () => `p${++n}`;

/** A horizontal line from x0 to x1 at y, a point every `step`, pressure rising along it. */
function line(id: string, x0: number, x1: number, y: number, step = 2, extra: Partial<StrokeItem> = {}): StrokeItem {
  const points: InkPoint[] = [];
  for (let x = x0, i = 0; x <= x1 + 1e-9; x += step, i++) points.push({ x, y, p: 0.2 + (0.6 * (x - x0)) / (x1 - x0), tilt: 1.2, az: 0.3, t: i * 4 });
  const width = extra.width ?? 2;
  return { id, type: 'stroke', tool: 'pen', color: '#4338ca', width, points, bbox: pointsBBox(points, width / 2), createdAt: 5, style: 'brush', smoothing: 2, ...extra };
}

const xs = (s: StrokeItem) => s.points.map((q) => q.x);

describe('splitStroke', () => {
  it('a dab in the middle leaves two pieces with a gap as wide as the eraser', () => {
    const s = line('a', 0, 100, 50);
    const pieces = splitStroke(s, [{ x: 50, y: 50 }], 10, ids)!;
    expect(pieces).toHaveLength(2);
    const [l, r] = pieces as [StrokeItem, StrokeItem];
    // Cut where the centreline comes within radius + half the width: the round ends just touch the eraser.
    expect(Math.max(...xs(l))).toBeCloseTo(39, 1);
    expect(Math.min(...xs(r))).toBeCloseTo(61, 1);
    // Visible gap (between the ends' outer edges) = 2 × radius.
    expect(Math.min(...xs(r)) - 1 - (Math.max(...xs(l)) + 1)).toBeCloseTo(20, 1);
    for (const p of pieces) {
      expect(p.id).not.toBe('a');
      expect(p).toMatchObject({ type: 'stroke', tool: 'pen', color: '#4338ca', width: 2, style: 'brush', smoothing: 2, createdAt: 5 });
      expect(p.bbox).toEqual(pointsBBox(p.points, 1));
    }
  });

  it("keeps the stroke's own points (pressure, tilt, time); a cut adds one interpolated point", () => {
    const s = line('a', 0, 100, 50);
    const [l] = splitStroke(s, [{ x: 50, y: 50 }], 10, ids) as [StrokeItem];
    const own = s.points.filter((q) => q.x < 39);
    expect(l.points.slice(0, -1)).toEqual(own);
    const end = l.points[l.points.length - 1]!;
    expect(end.p).toBeCloseTo(0.2 + 0.6 * 0.39, 3);
    expect(end.t).toBeCloseTo((39 / 2) * 4, 1);
  });

  it('misses: null; rubs everything: []', () => {
    const s = line('a', 0, 100, 50);
    expect(splitStroke(s, [{ x: 50, y: 80 }], 10, ids)).toBeNull();
    expect(splitStroke(s, [{ x: -20, y: 50 }, { x: 120, y: 50 }], 10, ids)).toEqual([]);
  });

  it('cuts a long two-point segment where the eraser crosses it', () => {
    const s = line('a', 0, 100, 50, 100); // just the two ends
    const pieces = splitStroke(s, [{ x: 30, y: 20 }, { x: 30, y: 80 }], 5, ids)!;
    expect(pieces.map((p) => [Math.min(...xs(p)), Math.max(...xs(p))].map((v) => Math.round(v)))).toEqual([
      [0, 24],
      [36, 100],
    ]);
  });

  it('an eraser path back and forth makes several pieces; rubbing the end shortens it', () => {
    const s = line('a', 0, 100, 50);
    const path = [20, 50, 80].map((x) => ({ x, y: 50 }));
    expect(splitStroke(s, [path[0]!], 4, ids)).toHaveLength(2);
    // A path is one long rub: from 20 to 80 nothing is left between the two ends.
    expect(splitStroke(s, [{ x: 20, y: 50 }, { x: 80, y: 51 }, { x: 20, y: 50 }], 4, ids)).toHaveLength(2);
    const end = splitStroke(s, [{ x: 100, y: 50 }], 10, ids)!;
    expect(end).toHaveLength(1);
    expect(Math.max(...xs(end[0]!))).toBeCloseTo(89, 1);
  });

  it('splits highlighter strokes too (their width counts)', () => {
    const s = line('h', 0, 100, 50, 2, { tool: 'highlighter', color: '#fde68a', width: 12, style: undefined, smoothing: undefined });
    const pieces = splitStroke(s, [{ x: 50, y: 50 }], 10, ids)!;
    expect(pieces).toHaveLength(2);
    expect(Math.max(...xs(pieces[0]!))).toBeCloseTo(34, 1);
    expect(pieces[0]).toMatchObject({ tool: 'highlighter', color: '#fde68a', width: 12 });
  });
});

describe('planPartialErase', () => {
  it('splits strokes, erases shapes whole, never touches text or images', () => {
    const items: Item[] = [
      line('s', 0, 100, 50),
      { id: 'sh', type: 'shape', kind: 'rect', pts: [[40, 40], [60, 40], [60, 60], [40, 60]], color: '#000', width: 2 },
      { id: 't', type: 'text', x: 40, y: 40, w: 30, text: 'hi', fontSize: 16, color: '#000' },
      { id: 'i', type: 'image', assetId: 'a', x: 40, y: 40, w: 30, h: 30 },
      line('far', 0, 100, 300),
    ];
    const plan = planPartialErase(items, [{ x: 50, y: 40 }, { x: 50, y: 60 }], 4, ids);
    expect(plan.remove).toEqual(['sh']);
    expect(plan.split.map((s) => [s.id, s.pieces.length])).toEqual([['s', 2]]);
  });

  it('is fast on a dense page (3000 strokes)', () => {
    const items: Item[] = [];
    for (let r = 0; r < 50; r++) for (let c = 0; c < 10; c++) items.push(...handwriting(`d${r}_${c}_`, 'cos(x)', 20 + c * 56, 20 + r * 16, 9));
    expect(items.length).toBeGreaterThan(3000);
    const path = Array.from({ length: 8 }, (_, i) => ({ x: 100 + i * 4, y: 200 + i }));
    planPartialErase(items, path, 10, ids);
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) planPartialErase(items, path, 10, ids);
    expect((performance.now() - t0) / 20).toBeLessThan(8);
  });
});

describe('Page.applyErase', () => {
  it('replaces the stroke by its pieces in its z-order slot, in one undo step that restores it', () => {
    const page = newPage();
    page.addItems([stroke('below', 0, 0, 10, 10), line('s', 0, 100, 50), stroke('above', 0, 0, 10, 10)]);
    const um = createUndoManager(page);
    const plan = planPartialErase(page.items(), [{ x: 50, y: 50 }], 10, ids);
    page.applyErase(plan);
    const order = page.items().map((it) => it.id);
    const pieces = plan.split[0]!.pieces.map((p) => p.id);
    expect(order).toEqual(['below', ...pieces, 'above']);
    expect(page.item(pieces[0]!)).toMatchObject({ type: 'stroke', style: 'brush' });
    expect(um.undoStack).toHaveLength(1);
    um.undo();
    expect(page.items().map((it) => it.id)).toEqual(['below', 's', 'above']);
    const back = (page.item('s') as StrokeItem).points;
    expect(back).toHaveLength(line('s', 0, 100, 50).points.length);
    back.forEach((q, i) => expect(q.x).toBeCloseTo(i * 2, 1));
    um.redo();
    expect(page.items().map((it) => it.id)).toEqual(['below', ...pieces, 'above']);
  });

  it('a reading of the stroke reads its pieces and goes stale; undo brings the fresh reading back', () => {
    const page = newPage();
    page.addItems([line('s', 0, 100, 50), line('t', 0, 100, 60)]);
    const rid = page.setReading(['s', 't'], 'two lines', 'agent', 'Claude')!;
    const um = createUndoManager(page);
    const plan = planPartialErase(page.items(), [{ x: 50, y: 40 }, { x: 50, y: 52 }], 3, ids);
    page.applyErase(plan);
    const r = page.readings().find((x) => x.id === rid)!;
    expect(r.stale).toBe(true);
    expect(r.ids.sort()).toEqual([...plan.split[0]!.pieces.map((p) => p.id), 't'].sort());
    um.undo();
    expect(page.readings().find((x) => x.id === rid)).toMatchObject({ ids: ['s', 't'] });
    expect(page.readings().find((x) => x.id === rid)!.stale).toBeUndefined();
  });

  it('a reading whose only stroke is rubbed out completely goes with it', () => {
    const page = newPage();
    page.addItem(line('s', 0, 20, 50));
    page.setReading(['s'], 'dash', 'user');
    page.applyErase(planPartialErase(page.items(), [{ x: -10, y: 50 }, { x: 30, y: 50 }], 5, ids));
    expect(page.items()).toEqual([]);
    expect(page.readings()).toEqual([]);
  });

  it('a comment thread on the stroke follows its pieces', () => {
    const page = newPage();
    page.addItem(line('s', 0, 100, 50));
    const cid = page.addComment({ author: { kind: 'agent', name: 'Claude' }, text: 'nice', anchorIds: ['s'] });
    const plan = planPartialErase(page.items(), [{ x: 50, y: 50 }], 10, ids);
    page.applyErase(plan);
    const c = page.comments().find((x) => x.id === cid)!;
    expect(c.anchorIds).toEqual(['s', ...plan.split[0]!.pieces.map((p) => p.id)]);
  });

  it('agents see the split as the old stroke erased and the pieces added, in a region that replaces the old one', () => {
    const nb = newNotebook();
    const pid = nb.pages()[0]!.id;
    const page = newPage();
    const word = write(page, 'w', 'cos(x)', 60, 100);
    const pages = { [pid]: page };
    const regions: QinkRegions = emptyRegions();
    let ink: Record<string, InkSeen> = {};
    let rev = 0;
    const update = () => {
      const u = encodeQinkUpdate(nb, pages, regions, ink, { session: 's', rev: ++rev, client: 'a' });
      ink = { ...ink, ...u.ink };
      return u;
    };
    update(); // first look: R1
    const c = page.item(word[0]!) as StrokeItem; // the "c"
    const mid = c.points[Math.floor(c.points.length / 2)]!;
    const plan = planPartialErase(page.items(), [{ x: mid.x, y: mid.y }], 1.2, ids);
    expect(plan.split.map((s) => s.id)).toContain(word[0]);
    page.applyErase(plan);
    const pieces = plan.split.reduce((k, s) => k + s.pieces.length, 0);
    const u = update();
    expect(u.text.split('\n')[1]).toMatch(new RegExp(`^R2 \\[1\\] p1 @\\d+,\\d+ \\d+x\\d+ \\+${pieces} -${plan.split.length} \\(was R1\\)$`));
    const row = u.image!.rows[0]!;
    expect(row.fresh.sort()).toEqual(plan.split.flatMap((s) => s.pieces.map((p) => p.id)).sort());
    expect(row.erased).toHaveLength(plan.split.length);
  });
});
