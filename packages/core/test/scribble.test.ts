import { describe, expect, it } from 'vitest';
import { detectScribble, scribbleShape, scribbleTargets, UNITS_PER_MM, type InkPoint, type Item, type StrokeItem } from '../src';
import { pointsBBox } from '../src/geometry/bbox';
import { arc, capitalM, capitalN, capitalZ, eight, loops, mCursive, mPrint, sine, spiral, trace, wPrint, zigzag } from './gestures';
import { handwriting } from './ink';

const strokeOf = (id: string, points: InkPoint[], width = 1.8): StrokeItem => ({
  id,
  type: 'stroke',
  tool: 'pen',
  color: '#27272a',
  width,
  points,
  bbox: pointsBBox(points, width / 2),
  createdAt: 0,
});

/** A word in fake handwriting about 30 mm wide at page (x, y), 7 mm tall. */
const word = (prefix: string, x: number, y: number) => handwriting(prefix, 'cos(x)', x, y, 20);
const span = (items: Item[]) => {
  const b = pointsBBox(items.flatMap((it) => (it.type === 'stroke' ? it.points : [])));
  return { x: b[0], y: b[1], w: (b[2] - b[0]) / UNITS_PER_MM, h: (b[3] - b[1]) / UNITS_PER_MM };
};

describe('scribble shape: real-looking zig-zags', () => {
  const cases: [string, InkPoint[]][] = [
    ['horizontal back-and-forth over a word', trace(zigzag(28, 0.7, 10), { speed: 160, jitter: 0.12 })],
    ['vertical scratch-out across a word', trace(zigzag(7, 0.9, 14), { speed: 120, rotate: Math.PI / 2, jitter: 0.1 })],
    ['diagonal scribble', trace(zigzag(12, 1, 9), { speed: 140, rotate: -0.6, seed: 3 })],
    ['small, over one letter', trace(zigzag(4, 0.45, 7), { speed: 90, seed: 5 })],
    ['quick, five legs', trace(zigzag(15, 1.2, 5), { speed: 200, seed: 9 })],
    ['uneven legs', trace(zigzag(18, 0.9, 12, 0.45, 11), { speed: 150, jitter: 0.2 })],
    ['slower but still quick', trace(zigzag(20, 1, 8), { speed: 70 })],
  ];
  for (const [name, pts] of cases) {
    it(name, () => {
      const s = scribbleShape(pts);
      expect(s, JSON.stringify(s)).toMatchObject({ ok: true });
    });
  }
});

describe('scribble shape: handwriting never triggers (false-positive corpus)', () => {
  const corpus: [string, InkPoint[]][] = [];
  for (const h of [2.5, 3.5, 5, 8]) {
    for (const speed of [25, 45, 90]) {
      const o = { speed, seed: Math.round(h * 10 + speed) };
      corpus.push([`m (print) ${h} mm ${speed} mm/s`, trace(mPrint(h), o)]);
      corpus.push([`mmm (print humps) ${h} mm ${speed} mm/s`, trace(mPrint(h, 6), o)]);
      corpus.push([`mmm (cursive) ${h} mm ${speed} mm/s`, trace(mCursive(h, 3), o)]);
      corpus.push([`w ${h} mm ${speed} mm/s`, trace(wPrint(h), o)]);
      corpus.push([`www ${h} mm ${speed} mm/s`, trace(wPrint(h, 3), o)]);
      corpus.push([`MMM ${h * 1.6} mm ${speed} mm/s`, trace(capitalM(h * 1.6), o)]);
      corpus.push([`NNN ${h * 1.6} mm ${speed} mm/s`, trace(capitalN(h * 1.6), o)]);
      corpus.push([`ZZZ ${h * 1.6} mm ${speed} mm/s`, trace(capitalZ(h * 1.6), o)]);
      corpus.push([`eee ${h} mm ${speed} mm/s`, trace(loops(h, 4), o)]);
      corpus.push([`lll ${h} mm ${speed} mm/s`, trace(loops(h * 2, 4, true), o)]);
      corpus.push([`sine ${h} mm ${speed} mm/s`, trace(sine(h / 2, h * 1.2, 8), o)]);
      corpus.push([`8 ${h * 2} mm ${speed} mm/s`, trace(eight(h * 2), o)]);
    }
  }
  corpus.push(['spiral', trace(spiral(8, 4), { speed: 60 })]);
  corpus.push(['a fast sawtooth with legs far apart (VVVV)', trace(zigzag(8, 5, 8, 0), { speed: 150 })]);
  corpus.push(['a double underline, back and forth', trace(zigzag(40, 0.8, 2), { speed: 150 })]);
  corpus.push(['a slow, careful zig-zag (drawing a spring)', trace(zigzag(8, 1, 10), { speed: 30 })]);
  corpus.push(['a tiny tremor', trace(zigzag(0.8, 0.1, 12), { speed: 80 })]);
  // Tall, fast coils (a spring, a row of tall loops), upright and on their side.
  for (const speed of [120, 200, 260]) {
    corpus.push([`tall coil ${speed} mm/s`, trace(loops(12, 8, true), { speed })]);
    corpus.push([`tall coil on its side ${speed} mm/s`, trace(loops(12, 8, true), { speed, rotate: Math.PI / 2 })]);
    corpus.push([`tight tall coil ${speed} mm/s`, trace(loops(20, 12, true), { speed, seed: 4 })]);
  }

  it(`rejects all ${corpus.length} strokes`, () => {
    const hits = corpus.filter(([, pts]) => scribbleShape(pts).ok).map(([n, pts]) => `${n}: ${JSON.stringify(scribbleShape(pts))}`);
    expect(hits).toEqual([]);
  });
});

describe('scribble to erase', () => {
  it('a scribble over a word deletes the word, and nothing else', () => {
    const w = word('w', 100, 100);
    const far = word('f', 100, 300);
    const s = span(w);
    // Back and forth over the word, a little wider than it.
    const pts = trace(zigzag(s.w + 2, (s.h + 2) / 10, 10), { at: [s.x - UNITS_PER_MM, s.y - UNITS_PER_MM], speed: 160 });
    const ids = detectScribble([...w, ...far], pts, 1.8);
    expect(ids?.sort()).toEqual(w.map((x) => x.id).sort());
  });

  it('a scribble over half a word deletes only the strokes mostly inside it', () => {
    const w = word('w', 100, 100);
    const s = span(w);
    const pts = trace(zigzag(s.w * 0.45, (s.h + 2) / 10, 10), { at: [s.x - UNITS_PER_MM, s.y - UNITS_PER_MM], speed: 160 });
    const ids = detectScribble(w, pts, 1.8) ?? [];
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.length).toBeLessThan(w.length);
    const right = s.x + s.w * UNITS_PER_MM * 0.6;
    for (const id of ids) expect(w.find((x) => x.id === id)!.bbox[0]).toBeLessThan(right);
  });

  it('shading or a scribble over empty paper deletes nothing (it is kept as ink)', () => {
    const far = word('f', 100, 300);
    const pts = trace(zigzag(30, 0.6, 16), { at: [100, 100], speed: 180 });
    expect(scribbleShape(pts).ok).toBe(true);
    expect(detectScribble(far, pts, 1.8)).toBeNull();
    expect(detectScribble([], pts, 1.8)).toBeNull();
  });

  it('a long stroke that only passes through the scribble is not deleted', () => {
    const line = strokeOf('line', trace([[0, 0], [150, 0]], { at: [60, 120], speed: 200 }));
    const pts = trace(zigzag(10, 0.8, 10), { at: [200, 112], speed: 150 });
    expect(detectScribble([line], pts, 1.8)).toBeNull();
  });

  it('handwriting over existing ink is kept: writing "mmm" across a word erases nothing', () => {
    const w = word('w', 100, 100);
    const s = span(w);
    const pts = trace(mPrint(s.h, 8), { at: [s.x, s.y], speed: 90 });
    expect(detectScribble(w, pts, 1.8)).toBeNull();
  });

  it('text boxes and images are never deleted; shapes under it are', () => {
    const items: Item[] = [
      { id: 't', type: 'text', x: 100, y: 100, w: 60, text: 'hello', fontSize: 16, color: '#000' },
      { id: 's', type: 'shape', kind: 'rect', pts: [[105, 104], [140, 104], [140, 116], [105, 116]], color: '#000', width: 1.8 },
    ];
    const pts = trace(zigzag(18, 0.6, 12), { at: [100, 100], speed: 160 });
    expect(detectScribble(items, pts, 1.8)).toEqual(['s']);
  });

  it('is fast on a dense page', () => {
    const items: Item[] = [];
    for (let r = 0; r < 40; r++) for (let c = 0; c < 6; c++) items.push(...handwriting(`d${r}_${c}_`, 'cos(x)', 40 + c * 90, 20 + r * 20, 14));
    const pts = trace(zigzag(30, 0.6, 12), { at: [130, 400], speed: 160 });
    const t0 = Date.now();
    for (let i = 0; i < 10; i++) detectScribble(items, pts, 1.8);
    expect((Date.now() - t0) / 10).toBeLessThan(25);
  });
});

// ---- shading inside an outline never erases the outline (review of PR #68) ----

/**
 * Back-and-forth hatching (mm), as a hand shades: a zig-zag whose turns move on by `gap`, from y0 to y1, turning at
 * `left(y)` and `right(y)`.
 */
function hatch(y0: number, y1: number, gap: number, left: (y: number) => number, right: (y: number) => number): [number, number][] {
  const pl: [number, number][] = [];
  for (let y = y0, i = 0; y <= y1 + 1e-9; y += gap, i++) pl.push([i % 2 ? right(y) : left(y), y]);
  return pl;
}

const AT: [number, number] = [200, 200];
/** A 30 × 15 mm box drawn by hand (a stroke) and the same box snapped (a shape), top-left at AT. */
const boxStroke = () => strokeOf('box', trace([[0, 0], [30, 0], [30, 15], [0, 15], [0, 0]], { at: AT, speed: 40 }));
const boxShape = (): Item => {
  const [x, y] = AT;
  const u = UNITS_PER_MM;
  return { id: 'box', type: 'shape', kind: 'rect', pts: [[x, y], [x + 30 * u, y], [x + 30 * u, y + 15 * u], [x, y + 15 * u]], color: '#000', width: 1.8 };
};
/** A 10 mm circle (radius 5 mm, centre at AT + (5, 5) mm), by hand and snapped. */
const circleStroke = () => strokeOf('circle', trace(arc(5, 5, 5, 0, 2 * Math.PI, 48), { at: AT, speed: 40 }));
const circleShape = (): Item => {
  const u = UNITS_PER_MM;
  return { id: 'circle', type: 'shape', kind: 'ellipse', pts: [[AT[0], AT[1]], [AT[0] + 10 * u, AT[1] + 10 * u]], color: '#000', width: 1.8 };
};

describe('scribble to erase: shading inside an outline keeps the outline', () => {
  const cases: [string, Item, [number, number][], number][] = [];
  for (const speed of [80, 150, 200]) {
    for (const gap of [0.6, 1, 1.5]) {
      // Hatching that turns right at the box's sides (touching them), and hatching that overshoots them by 1 mm.
      for (const [label, inset] of [['touching the sides', 0], ['overshooting 1 mm', -1]] as const) {
        const pl = hatch(gap, 15 - gap, gap, () => inset, () => 30 - inset);
        cases.push([`box (stroke), ${label}, ${gap} mm apart, ${speed} mm/s`, boxStroke(), pl, speed]);
        cases.push([`box (shape), ${label}, ${gap} mm apart, ${speed} mm/s`, boxShape(), pl, speed]);
      }
      const r = 5;
      const half = (y: number) => Math.sqrt(Math.max(0, r * r - (y - r) ** 2));
      const disc = hatch(gap * 0.75, 2 * r - gap * 0.75, gap, (y) => r - half(y) + 0.1, (y) => r + half(y) - 0.1);
      cases.push([`circle (stroke), ${gap} mm apart, ${speed} mm/s`, circleStroke(), disc, speed]);
      cases.push([`circle (shape), ${gap} mm apart, ${speed} mm/s`, circleShape(), disc, speed]);
    }
  }
  // Diagonal shading inside the circle.
  const diag = hatch(1, 9, 0.8, (y) => 5 - Math.sqrt(Math.max(0, 25 - (y - 5) ** 2)) + 0.2, (y) => 5 + Math.sqrt(Math.max(0, 25 - (y - 5) ** 2)) - 0.2).map(
    ([x, y]): [number, number] => {
      const a = 0.6;
      const dx = x - 5, dy = y - 5;
      return [5 + dx * Math.cos(a) - dy * Math.sin(a), 5 + dx * Math.sin(a) + dy * Math.cos(a)];
    },
  );
  cases.push(['circle (stroke), diagonal shading, 150 mm/s', circleStroke(), diag, 150]);

  it('these are scribbles by their shape (so it is the targets test that keeps the outline)', () => {
    const fast = cases.filter(([n]) => / (150|200) mm\/s/.test(n) && !/circle/.test(n));
    expect(fast.filter(([, , pl, speed]) => scribbleShape(trace(pl, { at: AT, speed, seed: 3 })).ok).length).toBeGreaterThan(fast.length / 2);
  });

  for (const [name, target, pl, speed] of cases) {
    it(name, () => {
      const pts = trace(pl, { at: AT, speed, seed: 3 });
      // The targets alone (whether or not the stroke passes as a scribble), and the whole test.
      expect(scribbleTargets([target], pts, 1.8)).toEqual([]);
      expect(detectScribble([target], pts, 1.8)).toBeNull();
    });
  }

  it('still erases the box when the scribble crosses it, and a word written inside the box when that is scribbled over', () => {
    // Across the box's right side and beyond, as someone striking it out does.
    const across = trace(zigzag(40, 1.2, 14, 0.1), { at: [AT[0] - 5 * UNITS_PER_MM, AT[1] - 1 * UNITS_PER_MM], speed: 250 });
    expect(scribbleShape(across).ok).toBe(true);
    expect(detectScribble([boxStroke()], across, 1.8)).toEqual(['box']);
    // A word inside the box: scribbling over the word deletes the word, never the box around it.
    const w = handwriting('w', 'cos(x)', AT[0] + 3 * UNITS_PER_MM, AT[1] + 4 * UNITS_PER_MM, 20);
    const s = span(w);
    const over = trace(zigzag(s.w + 2, (s.h + 2) / 10, 10), { at: [s.x - UNITS_PER_MM, s.y - UNITS_PER_MM], speed: 160 });
    expect(detectScribble([boxStroke(), ...w], over, 1.8)?.sort()).toEqual(w.map((x) => x.id).sort());
  });
});
