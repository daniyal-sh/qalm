import { describe, expect, it } from 'vitest';
import { itemBBox, shapePolylines, snapShape, SNAP_HOLD_MS, type InkPoint, type ShapeItem } from '../src';

type P = [number, number];

/** Deterministic noise. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rot = (p: P, a: number, c: P = [0, 0]): P => [c[0] + (p[0] - c[0]) * Math.cos(a) - (p[1] - c[1]) * Math.sin(a), c[1] + (p[0] - c[0]) * Math.sin(a) + (p[1] - c[1]) * Math.cos(a)];

/** Dense points along a polyline (about 1 page unit apart). */
function densify(pl: P[]): P[] {
  const out: P[] = [];
  for (let i = 1; i < pl.length; i++) {
    const [a, b] = [pl[i - 1]!, pl[i]!];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1])));
    for (let k = 0; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  out.push(pl[pl.length - 1]!);
  return out;
}

/** One pass of Chaikin corner cutting: corners a hand rounds off. */
function chaikin(pl: P[], closed: boolean, cut = 0.08): P[] {
  const out: P[] = [];
  const n = pl.length;
  const m = closed ? n : n - 1;
  if (!closed) out.push(pl[0]!);
  for (let i = 0; i < m; i++) {
    const a = pl[i]!, b = pl[(i + 1) % n]!;
    out.push([a[0] + (b[0] - a[0]) * cut, a[1] + (b[1] - a[1]) * cut], [a[0] + (b[0] - a[0]) * (1 - cut), a[1] + (b[1] - a[1]) * (1 - cut)]);
  }
  if (!closed) out.push(pl[n - 1]!);
  return out;
}

interface Hand {
  /** jitter, as a fraction of the shape's size */
  jitter: number;
  /** slow wobble, fraction of size */
  wobble: number;
  seed: number;
}

/** A hand-drawn stroke along `pl`: wobble, jitter, then a still pen at the end (the hold). */
function draw(pl: P[], size: number, h: Hand, holdMs = 400): InkPoint[] {
  const r = rng(h.seed);
  const pts = densify(pl);
  const ph = r() * 6.28;
  const out: InkPoint[] = pts.map(([x, y], i) => {
    const w = Math.sin(i / 23 + ph) * h.wobble * size;
    return { x: x + w + (r() - 0.5) * 2 * h.jitter * size, y: y - w * 0.7 + (r() - 0.5) * 2 * h.jitter * size, p: 0.5, tilt: Math.PI / 2, az: 0, t: i * 4 };
  });
  const last = out[out.length - 1]!;
  for (let k = 1; k <= 6 && holdMs > 0; k++) out.push({ ...last, x: last.x + (r() - 0.5) * 0.4, t: last.t + (holdMs * k) / 6 });
  return out;
}

const C: P = [300, 400];

/** A closed outline through `v`, starting part-way along the first edge, with some overshoot past the start. */
function loop(v: P[], start: number, overshoot: number, round = true): P[] {
  const pl = round ? chaikin(v, true) : v;
  const ring = densify([...pl, pl[0]!]);
  const s = Math.floor(start * ring.length);
  const n = ring.length;
  const extra = Math.floor(overshoot * n);
  const out: P[] = [];
  for (let i = 0; i <= n + extra; i++) out.push(ring[(s + i) % n]!);
  return out;
}

function regularPts(k: number, R: number, phase: number, c: P = C): P[] {
  return Array.from({ length: k }, (_, i) => [c[0] + R * Math.cos(phase + (i * 2 * Math.PI) / k), c[1] + R * Math.sin(phase + (i * 2 * Math.PI) / k)] as P);
}

type Gen = (r: () => number) => { pl: P[]; size: number };

const GENERATORS: Record<string, Gen> = {
  line: (r) => {
    const a = r() * Math.PI, len = 60 + r() * 220;
    const d: P = [Math.cos(a) * len / 2, Math.sin(a) * len / 2];
    return { pl: [[C[0] - d[0], C[1] - d[1]], [C[0] + d[0], C[1] + d[1]]], size: len };
  },
  arrow: (r) => {
    const a = r() * 2 * Math.PI, len = 80 + r() * 200, bl = len * (0.12 + r() * 0.15), spread = (25 + r() * 25) * (Math.PI / 180);
    const tail: P = [C[0] - (Math.cos(a) * len) / 2, C[1] - (Math.sin(a) * len) / 2];
    const tip: P = [C[0] + (Math.cos(a) * len) / 2, C[1] + (Math.sin(a) * len) / 2];
    const barb = (s: number): P => [tip[0] - bl * Math.cos(a + s * spread), tip[1] - bl * Math.sin(a + s * spread)];
    // Three ways people draw it in one stroke: a hook, both barbs through the tip, or barb–tip–barb.
    const style = Math.floor(r() * 3);
    const pl: P[] = style === 0 ? [tail, tip, barb(1)] : style === 1 ? [tail, tip, barb(1), tip, barb(-1)] : [tail, tip, barb(1), tip, barb(-1)];
    return { pl, size: len };
  },
  'double-arrow': (r) => {
    const a = r() * Math.PI, len = 100 + r() * 180, bl = len * (0.12 + r() * 0.12), spread = (25 + r() * 25) * (Math.PI / 180);
    const p0: P = [C[0] - (Math.cos(a) * len) / 2, C[1] - (Math.sin(a) * len) / 2];
    const p1: P = [C[0] + (Math.cos(a) * len) / 2, C[1] + (Math.sin(a) * len) / 2];
    const b0: P = [p0[0] + bl * Math.cos(a + spread), p0[1] + bl * Math.sin(a + spread)];
    const b1: P = [p1[0] - bl * Math.cos(a + spread), p1[1] - bl * Math.sin(a + spread)];
    return { pl: [b0, p0, p1, b1], size: len };
  },
  rect: (r) => {
    const w = 80 + r() * 200, h = (0.35 + r() * 0.5) * w, a = r() < 0.4 ? 0 : (r() - 0.5) * 1.2 + (r() < 0.5 ? 0 : Math.PI / 2);
    const v: P[] = ([[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]] as P[]).map((p) => rot([C[0] + p[0], C[1] + p[1]], a, C));
    return { pl: loop(v, r(), 0.03 + r() * 0.08), size: (w + h) / 2 };
  },
  square: (r) => {
    const w = 80 + r() * 150, a = r() < 0.4 ? 0 : (r() - 0.5) * 1.2;
    const v: P[] = ([[-w / 2, -w / 2], [w / 2, -w / 2], [w / 2, w / 2], [-w / 2, w / 2]] as P[]).map((p) => rot([C[0] + p[0], C[1] + p[1]], a, C));
    return { pl: loop(v, r(), 0.03 + r() * 0.08), size: w };
  },
  ellipse: (r) => {
    const rx = 50 + r() * 120, ry = (0.35 + r() * 0.5) * rx, a = r() * Math.PI, n = 120;
    const v: P[] = Array.from({ length: n }, (_, i) => rot([C[0] + rx * Math.cos((i / n) * 2 * Math.PI), C[1] + ry * Math.sin((i / n) * 2 * Math.PI)], a, C));
    return { pl: loop(v, r(), 0.03 + r() * 0.1, false), size: rx + ry };
  },
  circle: (r) => {
    const R = 40 + r() * 120, n = 120;
    return { pl: loop(regularPts(n, R, 0), r(), 0.03 + r() * 0.1, false), size: 2 * R };
  },
  triangle: (r) => {
    // Any reasonably fat triangle: equilateral-ish to right-angled.
    const R = 60 + r() * 120, a0 = r() * 2 * Math.PI;
    const v: P[] = [0, 1, 2].map((i) => {
      const a = a0 + (i * 2 * Math.PI) / 3 + (r() - 0.5) * 0.6;
      return [C[0] + R * Math.cos(a), C[1] + R * Math.sin(a)] as P;
    });
    return { pl: loop(v, r(), 0.03 + r() * 0.08), size: R * 1.5 };
  },
  diamond: (r) => {
    const w = 80 + r() * 140, h = (0.7 + r() * 0.8) * w, a = r() < 0.6 ? 0 : (r() - 0.5) * 0.5;
    const v: P[] = ([[0, -h / 2], [w / 2, 0], [0, h / 2], [-w / 2, 0]] as P[]).map((p) => rot([C[0] + p[0], C[1] + p[1]], a, C));
    return { pl: loop(v, r(), 0.03 + r() * 0.08), size: (w + h) / 2 };
  },
  pentagon: (r) => {
    const R = 60 + r() * 120;
    return { pl: loop(regularPts(5, R, -Math.PI / 2 + (r() - 0.5) * 0.4), r(), 0.03 + r() * 0.08), size: 2 * R };
  },
  hexagon: (r) => {
    const R = 60 + r() * 120;
    return { pl: loop(regularPts(6, R, (r() - 0.5) * 0.6), r(), 0.03 + r() * 0.08), size: 2 * R };
  },
  star: (r) => {
    // A pentagram in one stroke: every other tip.
    const R = 70 + r() * 110;
    const tips = regularPts(5, R, -Math.PI / 2 + (r() - 0.5) * 0.3);
    const order = [0, 2, 4, 1, 3].map((i) => tips[i]!);
    return { pl: loop(order, 0, 0.02 + r() * 0.05, false), size: 2 * R };
  },
};

/** What each class should snap to (squares and circles are rects and ellipses with equal sides). */
const EXPECT: Record<string, string> = { square: 'rect', circle: 'ellipse' };

/** Handwriting-like strokes that must not snap, even held. */
const HANDWRITING: Record<string, (r: () => number) => P[]> = {
  cursive: (r) => Array.from({ length: 200 }, (_, i) => [100 + i * 1.2, 400 + Math.sin(i / 6 + r()) * 14 - (i % 40 < 20 ? 0 : 6)] as P),
  e: (r) => {
    const out: P[] = [[100, 400], [140, 400]];
    for (let i = 0; i <= 50; i++) {
      const a = -0 - (i / 50) * 1.8 * Math.PI;
      out.push([120 + 20 * Math.cos(a), 400 + 20 * Math.sin(a) * (0.9 + r() * 0.05)]);
    }
    return out;
  },
  a: (r) => {
    const out: P[] = [];
    for (let i = 0; i <= 40; i++) {
      const t = 0.3 * Math.PI + (i / 40) * 2 * Math.PI;
      out.push([120 + 18 * Math.cos(t), 400 + 18 * Math.sin(t)]);
    }
    out.push([140, 385 + r()], [140, 420], [146, 424]);
    return out;
  },
  s: () => Array.from({ length: 60 }, (_, i) => [120 + 20 * Math.sin((i / 60) * 2 * Math.PI) * (i < 30 ? -1 : 1) * 0.9, 380 + i * 0.8] as P),
  eight: () => Array.from({ length: 120 }, (_, i) => [120 + 18 * Math.sin((i / 120) * 4 * Math.PI), 400 - 40 * Math.cos((i / 120) * 2 * Math.PI)] as P),
  two: () => [...Array.from({ length: 30 }, (_, i) => [110 + 20 * Math.cos(Math.PI + (i / 30) * 1.3 * Math.PI), 390 + 18 * Math.sin(Math.PI + (i / 30) * 1.3 * Math.PI)] as P), [104, 430], [146, 430]],
  m: () => [[100, 430], [100, 400], [112, 398], [120, 430], [122, 400], [134, 398], [142, 430]],
  L: () => [[100, 380], [100, 430], [130, 430]],
  V: () => [[100, 380], [120, 430], [140, 380]],
  Z: () => [[100, 380], [140, 380], [100, 430], [140, 430]],
  N: () => [[100, 430], [100, 380], [140, 430], [140, 380]],
  zigzag: () => [[100, 400], [120, 380], [140, 400], [160, 380], [180, 400], [200, 380]],
  spiral: () => Array.from({ length: 150 }, (_, i) => [120 + (5 + i * 0.25) * Math.cos(i / 8), 400 + (5 + i * 0.25) * Math.sin(i / 8)] as P),
  scribble: (r) => Array.from({ length: 80 }, () => [100 + r() * 60, 380 + r() * 50] as P),
};

function hand(seed: number, sloppy = 1): Hand {
  const r = rng(seed * 7 + 3);
  return { jitter: (0.004 + r() * 0.008) * sloppy, wobble: (0.004 + r() * 0.012) * sloppy, seed };
}

const VARIANTS = 40;

function classify(points: InkPoint[]): string {
  return snapShape(points, SNAP_HOLD_MS)?.kind ?? 'none';
}

function confusion() {
  const table: Record<string, Record<string, number>> = {};
  for (const [name, gen] of Object.entries(GENERATORS)) {
    table[name] = {};
    for (let i = 0; i < VARIANTS; i++) {
      const r = rng(1000 + i * 31 + name.length);
      const { pl, size } = gen(r);
      const got = classify(draw(pl, size, hand(i + name.length * 101)));
      table[name]![got] = (table[name]![got] ?? 0) + 1;
    }
  }
  for (const [name, gen] of Object.entries(HANDWRITING)) {
    const key = `hw:${name}`;
    table[key] = {};
    for (let i = 0; i < 10; i++) {
      const got = classify(draw(gen(rng(i + 7)), 40, hand(i + 500, 0.6)));
      table[key]![got] = (table[key]![got] ?? 0) + 1;
    }
  }
  return table;
}

describe('snapShape: hold to snap', () => {
  it('needs the pen held still for SNAP_HOLD_MS', () => {
    const { pl, size } = GENERATORS.rect!(rng(1));
    const pts = draw(pl, size, hand(1));
    expect(snapShape(pts, SNAP_HOLD_MS - 1)).toBeNull();
    expect(snapShape(pts, SNAP_HOLD_MS)?.kind).toBe('rect');
  });

  it('never snaps tiny strokes or dots', () => {
    expect(snapShape(draw([[10, 10], [13, 12]], 3, hand(2)), 1000)).toBeNull();
    expect(snapShape([{ x: 1, y: 1, p: 0.5, tilt: 1.5, az: 0, t: 0 }], 1000)).toBeNull();
  });
});

describe('snapShape: classes', () => {
  const table = confusion();

  it('prints the confusion table', async () => {
    const cols = [...new Set(Object.values(table).flatMap((r) => Object.keys(r)))].sort();
    const lines = [`| drawn \\ snapped | ${cols.join(' | ')} |`, `|---|${cols.map(() => '---').join('|')}|`];
    for (const [row, r] of Object.entries(table)) lines.push(`| ${row} | ${cols.map((c) => r[c] ?? '').join(' | ')} |`);
    // SHAPE_TABLE=<file> writes it out (vitest output is quiet here); the PR quotes it.
    const out = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.SHAPE_TABLE;
    if (out) (await import('node:fs' as string) as { writeFileSync(p: string, d: string): void }).writeFileSync(out, lines.join('\n') + '\n');
    expect(lines.length).toBeGreaterThan(2);
  });

  for (const name of Object.keys(GENERATORS)) {
    it(`recognises ${name} (≥ 90% of ${VARIANTS} sloppy variants, never the wrong shape more than twice)`, () => {
      const want = EXPECT[name] ?? name;
      const row = table[name]!;
      expect(row[want] ?? 0).toBeGreaterThanOrEqual(Math.ceil(VARIANTS * 0.9));
      const wrong = Object.entries(row).filter(([k]) => k !== want && k !== 'none').reduce((n, [, v]) => n + v, 0);
      expect(wrong).toBeLessThanOrEqual(2);
    });
  }

  it('leaves handwriting alone even when held', () => {
    for (const [name, row] of Object.entries(table)) {
      if (!name.startsWith('hw:')) continue;
      expect([name, row.none ?? 0]).toEqual([name, 10]);
    }
  });
});

describe('snapShape: geometry', () => {
  const held = (pl: P[], size: number, seed = 3) => snapShape(draw(pl, size, hand(seed)), 400)!;

  it('snaps near-horizontal and near-vertical lines exactly', () => {
    const h = held([[100, 400], [300, 408]], 200); // 2.3°
    expect(h.kind).toBe('line');
    expect(h.pts[0]![1]).toBeCloseTo(h.pts[1]![1], 6);
    const v = held([[300, 100], [292, 300]], 200);
    expect(v.pts[0]![0]).toBeCloseTo(v.pts[1]![0], 6);
    const d = held([[100, 100], [300, 300]], 280);
    expect(Math.abs(d.pts[0]![0] - d.pts[1]![0])).toBeGreaterThan(150);
  });

  it('a rotated rectangle keeps its rotation and right angles; a nearly upright one becomes upright', () => {
    const v: P[] = ([[-100, -50], [100, -50], [100, 50], [-100, 50]] as P[]).map((p) => rot([C[0] + p[0], C[1] + p[1]], 0.5, C));
    const s = held(loop(v, 0.3, 0.06), 150);
    expect(s.kind).toBe('rect');
    const e = (i: number) => [s.pts[(i + 1) % 4]![0] - s.pts[i]![0], s.pts[(i + 1) % 4]![1] - s.pts[i]![1]];
    const dot = e(0)[0]! * e(1)[0]! + e(0)[1]! * e(1)[1]!;
    expect(Math.abs(dot)).toBeLessThan(1e-6);
    const ang = Math.atan2(e(0)[1]!, e(0)[0]!);
    expect(Math.abs(Math.sin(2 * (ang - 0.5)))).toBeLessThan(0.12);
    const up = held(loop(([[200, 300], [400, 304], [398, 400], [202, 398]] as P[]), 0.1, 0.05), 150);
    expect(up.kind).toBe('rect');
    const [x0, y0, x1, y1] = itemBBox(up);
    expect(up.pts.every(([x, y]) => [x0 + up.width / 2, x1 - up.width / 2].some((q) => Math.abs(q - x) < 1e-6) && [y0 + up.width / 2, y1 - up.width / 2].some((q) => Math.abs(q - y) < 1e-6))).toBe(true);
  });

  it('a nearly square rectangle becomes a square, a nearly round ellipse a circle', () => {
    const sq = held(loop(([[200, 300], [300, 300], [300, 392], [200, 392]] as P[]), 0.2, 0.05), 100);
    const side = (i: number) => Math.hypot(sq.pts[(i + 1) % 4]![0] - sq.pts[i]![0], sq.pts[(i + 1) % 4]![1] - sq.pts[i]![1]);
    expect(side(0)).toBeCloseTo(side(1), 6);
    const c = held(loop(regularPts(120, 80, 0).map(([x, y]) => [x, C[1] + (y - C[1]) * 0.95] as P), 0.4, 0.06, false), 160);
    expect(c.kind).toBe('ellipse');
    const [a, b, , d] = c.pts as P[];
    expect(Math.hypot(b![0] - a![0], b![1] - a![1])).toBeCloseTo(Math.hypot(d![0] - a![0], d![1] - a![1]), 6);
  });

  it('a rotated ellipse keeps its axes', () => {
    const n = 120;
    const v: P[] = Array.from({ length: n }, (_, i) => rot([C[0] + 120 * Math.cos((i / n) * 2 * Math.PI), C[1] + 50 * Math.sin((i / n) * 2 * Math.PI)], 0.6, C));
    const e = held(loop(v, 0.2, 0.08, false), 170);
    expect(e.kind).toBe('ellipse');
    const [a, b, , d] = e.pts as P[];
    expect(Math.hypot(b![0] - a![0], b![1] - a![1])).toBeCloseTo(240, -1.3);
    expect(Math.hypot(d![0] - a![0], d![1] - a![1])).toBeCloseTo(100, -1.3);
    expect(Math.atan2(b![1] - a![1], b![0] - a![0])).toBeCloseTo(0.6, 1);
  });

  it('arrows point the way they were drawn; double arrows have two heads', () => {
    const a = held([[100, 400], [300, 400], [270, 385]], 200);
    expect(a.kind).toBe('arrow');
    expect(a.pts[1]![0]).toBeGreaterThan(a.pts[0]![0]); // tip on the right
    const back = held([[300, 400], [100, 400], [130, 415]], 200);
    expect(back.kind).toBe('arrow');
    expect(back.pts[1]![0]).toBeLessThan(back.pts[0]![0]);
    expect(shapePolylines(held([[128, 385], [100, 400], [300, 400], [272, 415]], 200))).toHaveLength(3);
  });

  it('regular polygons and stars come out regular, with a point or flat side on top', () => {
    const hex = held(loop(regularPts(6, 100, 0.05), 0.1, 0.05), 200);
    expect(hex.kind).toBe('hexagon');
    const rs = hex.pts.map((p) => Math.hypot(p[0] - C[0], p[1] - C[1]));
    expect(Math.max(...rs) - Math.min(...rs)).toBeLessThan(6);
    const star = held(loop([0, 2, 4, 1, 3].map((i) => regularPts(5, 100, -Math.PI / 2 + 0.05)[i]!), 0, 0.03, false), 200);
    expect(star.kind).toBe('star');
    expect(star.pts).toHaveLength(10);
    const top = star.pts.reduce((m, p) => (p[1] < m[1] ? p : m));
    expect(top[0]).toBeCloseTo(star.pts.reduce((s, p) => s + p[0], 0) / 10, 0);
  });

  it('every snapped shape has an outline for the canvas and the PDF', () => {
    for (const [name, gen] of Object.entries(GENERATORS)) {
      const { pl, size } = gen(rng(42));
      const s = snapShape(draw(pl, size, hand(9)), 400) as ShapeItem;
      expect([name, !!s]).toEqual([name, true]);
      const pls = shapePolylines(s);
      expect(pls.length).toBeGreaterThan(0);
      expect(pls.flat().every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))).toBe(true);
    }
  });
});
