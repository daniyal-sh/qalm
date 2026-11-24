import { describe, expect, it } from 'vitest';
import { detectScribble, scribbleShape, UNITS_PER_MM, type InkPoint, type Item, type StrokeItem } from '../src';
import { pointsBBox } from '../src/geometry/bbox';
import { capitalM, capitalN, capitalZ, eight, loops, mCursive, mPrint, sine, spiral, trace, wPrint, zigzag } from './gestures';
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
    const t0 = performance.now();
    for (let i = 0; i < 10; i++) detectScribble(items, pts, 1.8);
    expect((performance.now() - t0) / 10).toBeLessThan(25);
  });
});
