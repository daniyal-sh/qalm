import { describe, expect, it } from 'vitest';
import {
  boxGap,
  clusterBoxes,
  contextFor,
  encodeQinkRead,
  encodeQinkUpdate,
  emptyRegions,
  fromGrid,
  gridSize,
  inkInBox,
  pageUnit,
  registerRegion,
  renderRegionsSvg,
  resolveTarget,
  toGrid,
  MAX_REGIONS,
  type BBox,
  type InkSeen,
  type Page,
  type QinkRegions,
} from '../src';
import { newNotebook, newPage, stroke } from './helpers';
import { OWNER, write } from './ink';

const A4 = { w: 595, h: 842 };

describe('units and coordinates', () => {
  it('uses the ruling on ruled and grid paper, else 1.5 × the median stroke height, clamped', () => {
    expect(pageUnit('ruled', [])).toBe(24);
    expect(pageUnit('cornell', [])).toBe(24);
    expect(pageUnit('grid', [])).toBe(18);
    expect(pageUnit('blank', [])).toBe(24);
    // Median of 10, 10, 12, 60 (the dot at 1 doesn't count; the tall ∫ barely moves it): 1.5 × 11.
    expect(pageUnit('blank', [[0, 0, 5, 10], [0, 0, 5, 10], [0, 0, 5, 12], [0, 0, 5, 60], [0, 0, 1, 1]])).toBe(16.5);
    expect(pageUnit('blank', [[0, 0, 5, 100]])).toBe(48);
    expect(pageUnit('blank', [[0, 0, 5, 4]])).toBe(12);
  });

  it('maps page boxes to a 0–1000 grid across the width (A4 is 1000×1415), outward-rounded', () => {
    expect(gridSize(A4)).toBe('1000x1415');
    expect(gridSize({ w: 842, h: 595 })).toBe('1000x707');
    expect(toGrid([59.5, 100, 119, 120.1], A4)).toEqual([100, 168, 100, 34]);
    const b = fromGrid([100, 168, 100, 34], A4);
    expect(b[0]).toBeCloseTo(59.5);
    expect(b[2]).toBeCloseTo(119);
  });
});

describe('clustering', () => {
  it('joins boxes closer than the gap, transitively; far-apart ones stay separate', () => {
    const boxes: BBox[] = [
      [0, 0, 10, 10],
      [30, 0, 40, 10], // 20 from the first: joins at gap 48
      [70, 0, 80, 10], // 30 from the second
      [0, 500, 10, 510], // far below
    ];
    expect(clusterBoxes(boxes, 48)).toEqual([[0, 1, 2], [3]]);
    expect(clusterBoxes(boxes, 25)).toEqual([[0, 1], [2], [3]]);
  });

  it('merges groups whose boxes overlap, so regions never overlap', () => {
    // A tall stroke at x 100 spanning both rows, but too far (in x) from the short ones to join by gap.
    const boxes: BBox[] = [
      [0, 0, 300, 10],
      [0, 100, 300, 110],
      [150, -20, 152, 130],
    ];
    expect(clusterBoxes(boxes, 5)).toEqual([[0, 1, 2]]);
  });

  it('handles thousands of boxes quickly', () => {
    const boxes: BBox[] = Array.from({ length: 5000 }, (_, i) => [(i % 50) * 11, Math.floor(i / 50) * 30, (i % 50) * 11 + 8, Math.floor(i / 50) * 30 + 12]);
    const t0 = Date.now();
    const g = clusterBoxes(boxes, 10);
    expect(g).toHaveLength(100); // one per row (rows 18 apart, gap 10)
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});

describe('context', () => {
  const page = () => {
    const p = newPage();
    OWNER.above(p);
    OWNER.integral(p);
    OWNER.below(p);
    return p;
  };
  const boxesOf = (p: Page, ids: string[]) => ids.map((id) => (p.item(id) as { bbox: BBox }).bbox);
  const others = (p: Page, except: Set<string>) => p.items().filter((i) => !except.has(i.id));

  it("writing beside an equation pulls in the whole equation (the owner's page), not the rows above and below", () => {
    const p = page();
    const fresh = OWNER.addSub(p);
    const rest = others(p, new Set(fresh));
    const ctx = contextFor(boxesOf(p, fresh), rest.map((i) => (i as { bbox: BBox }).bbox), 24).map((j) => rest[j]!.id);
    const integral = p.items().filter((i) => i.id.startsWith('i')).map((i) => i.id);
    expect(new Set(ctx)).toEqual(new Set(integral)); // incl. the tall ∫ and the superscript ²
  });

  it('writing over an old equation (a correction on top of it) pulls in the whole equation', () => {
    const p = page();
    const fresh = [stroke('fix', 150, 104, 170, 118).id];
    p.addItem(stroke('fix', 150, 104, 170, 118));
    const rest = others(p, new Set(fresh));
    const ctx = contextFor(boxesOf(p, fresh), rest.map((i) => (i as { bbox: BBox }).bbox), 24).map((j) => rest[j]!.id);
    expect(ctx.every((id) => id.startsWith('i'))).toBe(true);
    expect(ctx).toHaveLength(p.items().filter((i) => i.id.startsWith('i')).length);
  });

  it('a stroke within half a unit of new ink is context even on another row; nothing far is', () => {
    const others: BBox[] = [
      [0, 30, 10, 40], // 8 below the new stroke's bottom (22): within 12
      [0, 60, 10, 70], // too far
    ];
    expect(contextFor([[0, 10, 10, 22]], others, 24)).toEqual([0]);
  });

  it('is bounded: a page of dense rows never comes in whole', () => {
    const boxes: BBox[] = [];
    for (let r = 0; r < 30; r++) for (let c = 0; c < 40; c++) boxes.push([c * 12, r * 26, c * 12 + 9, r * 26 + 22]);
    const ctx = contextFor([[0, 13 * 26, 9, 13 * 26 + 22]], boxes, 24);
    const rows = new Set(ctx.map((j) => Math.floor(boxes[j]![1] / 26)));
    expect(rows.size).toBeLessThanOrEqual(3);
    expect(ctx.length).toBeLessThanOrEqual(120);
  });
});

/** A notebook with one A4 ruled page holding `fill`. */
function setup(fill: (p: Page) => void = () => {}) {
  const nb = newNotebook();
  const pid = nb.pages()[0]!.id;
  const page = newPage();
  fill(page);
  return { nb, pid, page, pages: { [pid]: page } as Record<string, Page> };
}

/** Runs updates like the server: ink seen per page and the region registry persist between them. */
function agent(nb: ReturnType<typeof newNotebook>, pages: Record<string, Page>) {
  const regions: QinkRegions = emptyRegions();
  let ink: Record<string, InkSeen> = {};
  let rev = 0;
  return {
    regions,
    update(asks?: Parameters<typeof encodeQinkUpdate>[4]['asks']) {
      const u = encodeQinkUpdate(nb, pages, regions, ink, { session: 'calc', rev: ++rev, client: 'a1', asks });
      ink = { ...ink, ...u.ink };
      return u;
    },
  };
}

describe('Q-ink v1.0 updates', () => {
  it("the owner's page: first look, then the u-substitution as one region (new black, the integral grey)", () => {
    const { nb, pid, page, pages } = setup((p) => OWNER.integral(p));
    const a = agent(nb, pages);
    const first = a.update();
    expect(first.text).toBe('#q s=calc r=1 p1 1000x1415 first look\nR1 [1] p1 @99,154 253x68');
    expect(first.image!.rows).toMatchObject([{ label: '[1]', scale: 'first', context: [], erased: [] }]);
    expect(first.image!.rows[0]!.fresh).toHaveLength(page.items().length);

    const fresh = OWNER.addSub(page);
    const u = a.update();
    const [head, line, ...rest] = u.text.split('\n');
    expect(head).toBe('#q s=calc r=2 p1 1000x1415');
    expect(line).toBe(`R2 [1] p1 @99,154 596x68 +${fresh.length} (was R1)`);
    expect(rest).toEqual([]);
    const row = u.image!.rows[0]!;
    expect(new Set(row.fresh)).toEqual(new Set(fresh));
    expect(new Set(row.context)).toEqual(new Set(page.items().filter((i) => i.id.startsWith('i')).map((i) => i.id)));
    expect(a.regions.byLabel.R1!.replaced).toBe(true);
    expect(a.regions.byLabel.R2!.ids).toHaveLength(page.items().length);
    expect(pid).toBeTruthy();
  });

  it('far-apart clusters are separate regions, separate rows of the one image, in reading order', () => {
    const { nb, page, pages } = setup();
    const a = agent(nb, pages);
    a.update();
    write(page, 'q', 'y = 2x', 300, 600);
    write(page, 'p', 'x = 3', 60, 100);
    const u = a.update();
    expect(u.text.split('\n').slice(1)).toEqual(['R1 [1] p1 @100,181 79x14 +5', 'R2 [2] p1 @504,1021 96x25 +7']);
    expect(u.image!.rows.map((r) => r.label)).toEqual(['[1]', '[2]']);
  });

  it('never clips or caps new ink, however large', () => {
    const { nb, page, pages } = setup();
    const a = agent(nb, pages);
    a.update();
    const ids: string[] = [];
    for (let r = 0; r < 28; r++) ids.push(...write(page, `r${r}-`, 'x + 2 = y + 3 + x + 2 = y', 20, 80 + r * 26));
    const u = a.update();
    const rows = u.image!.rows;
    expect(rows).toHaveLength(1);
    expect(new Set(rows[0]!.fresh)).toEqual(new Set(ids));
    const box = rows[0]!.box;
    for (const id of ids) {
      const b = (page.item(id) as { bbox: BBox }).bbox;
      expect(b[0] >= box[0] && b[1] >= box[1] && b[2] <= box[2] && b[3] <= box[3]).toBe(true);
    }
    // Downscaled to stay near the budget, but never below the minimum scale.
    const { width, height } = renderRegionsSvg(pages, rows);
    expect(width * height).toBeLessThan(560_000);
  });

  it('erased strokes are faint rows of their own regions (-n), with context around them', () => {
    const { nb, page, pages } = setup((p) => OWNER.integral(p));
    const a = agent(nb, pages);
    a.update();
    page.removeItems(['i3']); // the "x" of 2x (one of its strokes)
    const u = a.update();
    expect(u.text.split('\n')[1]).toMatch(/^R2 \[1\] p1 @\d+,\d+ \d+x\d+ -1 \(was R1\)$/);
    const row = u.image!.rows[0]!;
    expect(row.fresh).toEqual([]);
    expect(row.erased).toHaveLength(1);
    expect(row.erased[0]!.length).toBeGreaterThan(1);
    expect(row.context.length).toBeGreaterThan(5);
    const { svg } = renderRegionsSvg(pages, u.image!.rows);
    expect(svg).toContain('stroke-dasharray');
    expect(svg).toContain('#f0a0a0');
    expect(svg).toContain('#8c8c8c');
  });

  it('moving ink is a change (shown where it is now); recolouring is not', () => {
    const { nb, page, pages } = setup((p) => write(p, 'w', 'x = 3', 60, 100));
    const a = agent(nb, pages);
    a.update();
    page.updateItem('w0', { color: '#ff0000' });
    expect(a.update().text).toBe('#q s=calc r=2 p1 1000x1415');
    const it = page.item('w0') as { points: { x: number; y: number }[]; bbox: BBox };
    page.updateItem('w0', { points: it.points.map((q) => ({ ...q, y: q.y + 300 })) as never, bbox: [it.bbox[0], it.bbox[1] + 300, it.bbox[2], it.bbox[3] + 300] });
    expect(a.update().text.split('\n')[1]).toMatch(/^R2 \[1\] p1 @100,685 15x15 \+1 \(was R1\)$/);
  });

  it('first look sends read regions as text; changes are always images', () => {
    const { nb, page, pages } = setup();
    const top = write(page, 'a', 'x = 3', 60, 100);
    const low = write(page, 'b', 'y = 2', 60, 400);
    page.setReading(top, 'x = 3', 'agent', 'Claude');
    page.setReading(low.slice(0, 2), 'y', 'user'); // only part of it
    const a = agent(nb, pages);
    const u = a.update();
    expect(u.text.split('\n').slice(1)).toEqual(['R1 p1 @100,181 79x14 "x = 3"', 'R2 [1] p1 @100,685 79x25']);
    expect(u.image!.rows).toHaveLength(1);
    // A stale reading is not trusted: the region is an image again.
    page.addItem(stroke('sup', 116, 160, 120, 166));
    const read = encodeQinkRead(nb, pages, a.regions, 'p1', 'a1');
    expect(read.text.split('\n')[1]).toMatch(/^R3 \[1\] p1 /);
  });

  it('asks about a selection: the selection and its context as a region row', () => {
    const { nb, pid, page, pages } = setup((p) => OWNER.integral(p));
    const a = agent(nb, pages);
    a.update();
    const u = a.update([{ pageId: pid, text: 'is this right?', sel: { itemIds: ['i3', 'i4'], bbox: [0, 0, 1, 1] }, commentId: 'c1' }]);
    // The selection plus its context is the same strokes as the first look's R1: same label.
    expect(u.text.split('\n')).toEqual(['#q s=calc r=2 p1 1000x1415', 'ask C1 R1 [1] p1 @99,154 253x68 "is this right?"']);
    expect(u.image!.rows[0]!.fresh).toEqual(['i3', 'i4']);
    expect(u.image!.rows[0]!.context.length).toBeGreaterThan(10);
    const gone = a.update([{ pageId: pid, text: 'and here?', sel: { itemIds: ['nope'], bbox: [100, 100, 200, 150] } }]);
    expect(gone.text.split('\n')[1]).toBe('ask p1@168,168,169,85 [1] "and here?"');
    expect(gone.image!.rows[0]!.clip).toBe(true);
  });
});

describe('region labels', () => {
  it('are never reused; the same strokes keep their label; overlaps say what they replace', () => {
    const r = emptyRegions();
    const a = registerRegion(r, { pageId: 'p', ids: ['a', 'b'], box: [0, 0, 10, 10] }, 'x');
    const b = registerRegion(r, { pageId: 'p', ids: ['b', 'a'], box: [0, 0, 10, 10] }, 'x');
    expect([a.label, b.label]).toEqual(['R1', 'R1']);
    const c = registerRegion(r, { pageId: 'p', ids: ['c'], box: [100, 100, 110, 110] }, 'x');
    const d = registerRegion(r, { pageId: 'p', ids: ['a', 'b', 'c', 'd'], box: [0, 0, 110, 110] }, 'x');
    expect(c).toEqual({ label: 'R2', was: [] });
    expect(d).toEqual({ label: 'R3', was: ['R1', 'R2'] });
    // Another agent's regions are its own.
    expect(registerRegion(r, { pageId: 'p', ids: ['a', 'b'], box: [0, 0, 10, 10] }, 'y')).toEqual({ label: 'R4', was: [] });
  });

  it('stays bounded, forgetting old replaced regions first', () => {
    const r = emptyRegions();
    for (let i = 0; i < MAX_REGIONS + 50; i++) registerRegion(r, { pageId: 'p', ids: [`s${i}`], box: [0, 0, 10, 10] }, 'x');
    expect(Object.keys(r.byLabel)).toHaveLength(MAX_REGIONS);
    expect(r.byLabel[`R${MAX_REGIONS + 50}`]).toBeTruthy();
    expect(r.next).toBe(MAX_REGIONS + 51);
  });
});

describe('refs', () => {
  it('resolves R#, boxes and pages; inkInBox takes ink whose centre is inside', () => {
    const { nb, pid, page } = setup((p) => OWNER.integral(p));
    const r = emptyRegions();
    registerRegion(r, { pageId: pid, ids: ['i0'], box: [1, 2, 3, 4] });
    expect(resolveTarget(nb, r, 'R1')).toMatchObject({ kind: 'region', label: 'R1', pageId: pid, pos: 1, ids: ['i0'] });
    expect(resolveTarget(nb, r, 'p1')).toEqual({ kind: 'page', pageId: pid, pos: 1 });
    const t = resolveTarget(nb, r, 'p1@99,138,100,91');
    expect(t.kind).toBe('box');
    const ids = inkInBox(page.items(), (t as { box: BBox }).box);
    expect(ids).toContain('i0');
    expect(ids).not.toContain('i30');
    expect(() => resolveTarget(nb, r, 'R9')).toThrow(/No region R9/);
    expect(() => resolveTarget(nb, r, 'p9')).toThrow(/No page p9/);
    expect(() => resolveTarget(nb, r, 'L4')).toThrow(/Bad ref/);
    expect(boxGap([0, 0, 1, 1], [3, 0, 4, 1])).toBe(2);
  });

  it('reads a region (its strokes now, with readings) and a box (a crop)', () => {
    const { nb, pid, page, pages } = setup((p) => OWNER.integral(p));
    const r = emptyRegions();
    const ids = page.items().map((i) => i.id);
    registerRegion(r, { pageId: pid, ids, box: [0, 0, 1, 1] });
    page.setReading(ids, '∫ 2x cos(x^2) dx', 'agent', 'Claude');
    const read = encodeQinkRead(nb, pages, r, 'R1');
    expect(read.text).toBe('#q R1 [1] p1 @99,154 253x68\nagent "∫ 2x cos(x^2) dx"');
    expect(read.image!.rows[0]!.scale).toBe('read');
    const box = encodeQinkRead(nb, pages, r, 'p1@99,138,100,91');
    expect(box.text).toBe('#q p1@99,138,100,91 [1]');
    expect(box.image!.rows[0]!.clip).toBe(true);
    page.removeItems(ids);
    expect(() => encodeQinkRead(nb, pages, r, 'R1')).toThrow(/erased/);
  });
});
