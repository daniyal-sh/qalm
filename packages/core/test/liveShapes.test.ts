// Live shapes (hold to snap while the pen is down, then drag to adjust): recognition of quick, sloppy real-hand
// strokes without a hold gate (`recognizeShape`), the hold constants, handwriting that must not snap, and `adjustShape`.
import { describe, expect, it } from 'vitest';
import { adjustShape, recognizeShape, snapShape, SNAP_HOLD_MS, SNAP_HOLD_TOLERANCE_MM, type InkPoint, type ShapeItem } from '../src';

type P = [number, number];
const DEG = Math.PI / 180;
const C: P = [300, 400];

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

/** One pass of corner cutting on a closed polygon. */
function chaikin(pl: P[], cut: number): P[] {
  const out: P[] = [];
  for (let i = 0; i < pl.length; i++) {
    const a = pl[i]!, b = pl[(i + 1) % pl.length]!;
    out.push([a[0] + (b[0] - a[0]) * cut, a[1] + (b[1] - a[1]) * cut], [a[0] + (b[0] - a[0]) * (1 - cut), a[1] + (b[1] - a[1]) * (1 - cut)]);
  }
  return out;
}

function regularPts(k: number, R: number, phase: number, c: P = C): P[] {
  return Array.from({ length: k }, (_, i) => [c[0] + R * Math.cos(phase + (i * 2 * Math.PI) / k), c[1] + R * Math.sin(phase + (i * 2 * Math.PI) / k)] as P);
}

/** A closed ring through `pl` from `start` (fraction), going `amount` times round (> 1 overshoots, < 1 leaves a gap). */
function ring(pl: P[], start: number, amount: number): P[] {
  const d = densify([...pl, pl[0]!]);
  const n = d.length;
  const s = Math.floor(start * n);
  return Array.from({ length: Math.floor(amount * n) + 1 }, (_, i) => d[(s + i) % n]!);
}

/**
 * A quick, sloppy hand: sparse samples (a fast pen at 60–120 Hz gives a point every few units), a slow wobble, jitter
 * and no trailing hold points (the overlays pass the points up to where the hold began).
 */
function quick(pl: P[], size: number, seed: number, o: { wobble?: number; jitter?: number; step?: number } = {}): InkPoint[] {
  const r = rng(seed);
  const dense = densify(pl);
  const step = Math.max(1, Math.round((o.step ?? 0.04) * size));
  const ph = r() * 6.28;
  const out: InkPoint[] = [];
  const at = (x: number, y: number, w: number, j: number) => out.push({ x: x + w + (r() - 0.5) * 2 * j, y: y - w * 0.6 + (r() - 0.5) * 2 * j, p: 0.5, tilt: Math.PI / 2, az: 0, t: out.length * 8 });
  for (let i = 0; i < dense.length; i += step) {
    const [x, y] = dense[i]!;
    at(x, y, Math.sin((i / dense.length) * 6.28 * 1.5 + ph) * (o.wobble ?? 0.02) * size, (o.jitter ?? 0.006) * size);
  }
  const [lx, ly] = dense[dense.length - 1]!;
  at(lx, ly, 0, 0);
  return out;
}

/** A rectangle `w` × `h` about C turned by `a`, its corners rounded with radius `r` (page units). */
function roundedRect(w: number, h: number, r: number, a: number): P[] {
  const out: P[] = [];
  const cs: [number, number, number][] = [[w / 2 - r, -h / 2 + r, -Math.PI / 2], [w / 2 - r, h / 2 - r, 0], [-w / 2 + r, h / 2 - r, Math.PI / 2], [-w / 2 + r, -h / 2 + r, Math.PI]];
  for (const [cx, cy, a0] of cs) for (let i = 0; i <= 8; i++) out.push(rot([C[0] + cx + r * Math.cos(a0 + (i / 8) * (Math.PI / 2)), C[1] + cy + r * Math.sin(a0 + (i / 8) * (Math.PI / 2))], a, C));
  return out;
}

type Real = { pl: P[]; size: number; wobble?: number; step?: number };
const REAL: Record<string, { want: string; gen: (r: () => number) => Real }> = {
  'wobbly circle': {
    want: 'ellipse',
    gen: (r) => {
      const R = 30 + r() * 120;
      return { pl: ring(regularPts(90, R, 0), r(), 0.92 + r() * 0.22), size: 2 * R, wobble: 0.025 + r() * 0.02 };
    },
  },
  'small quick circle': {
    want: 'ellipse',
    gen: (r) => {
      const R = 14 + r() * 12;
      return { pl: ring(regularPts(60, R, 0), r(), 0.95 + r() * 0.15), size: 2 * R, wobble: 0.03, step: 0.08 };
    },
  },
  'rounded rectangle': {
    want: 'rect',
    gen: (r) => {
      // Corner radius 10–25% of the short side.
      const w = 80 + r() * 200, h = (0.4 + r() * 0.6) * w, a = r() < 0.5 ? 0 : (r() - 0.5) * 0.8;
      return { pl: ring(roundedRect(w, h, (0.1 + r() * 0.15) * h, a), r(), 1 + r() * 0.08), size: (w + h) / 2 };
    },
  },
  'quick triangle': {
    want: 'triangle',
    gen: (r) => {
      const R = 50 + r() * 120, a0 = r() * 2 * Math.PI;
      const v: P[] = [0, 1, 2].map((i) => {
        const a = a0 + (i * 2 * Math.PI) / 3 + (r() - 0.5) * 0.5;
        return [C[0] + R * Math.cos(a), C[1] + R * Math.sin(a)] as P;
      });
      return { pl: ring(chaikin(v, 0.12), r() * 0.2, 1 + r() * 0.08), size: R * 1.5, step: 0.05 };
    },
  },
  'quick line': {
    want: 'line',
    gen: (r) => {
      const a = r() * Math.PI, len = 60 + r() * 260, bow = (r() - 0.5) * 0.06 * len;
      const d: P = [Math.cos(a), Math.sin(a)];
      const nrm: P = [-d[1], d[0]];
      const pl = Array.from({ length: 9 }, (_, i) => {
        const t = i / 8 - 0.5;
        const b = bow * (1 - 4 * t * t);
        return [C[0] + d[0] * t * len + nrm[0] * b, C[1] + d[1] * t * len + nrm[1] * b] as P;
      });
      return { pl, size: len, wobble: 0.008, step: 0.06 };
    },
  },
  'quick arrow': {
    want: 'arrow',
    gen: (r) => {
      const a = r() * 2 * Math.PI, len = 90 + r() * 200, bl = len * (0.15 + r() * 0.12), spread = (28 + r() * 20) * DEG;
      const tail: P = [C[0] - (Math.cos(a) * len) / 2, C[1] - (Math.sin(a) * len) / 2];
      const tip: P = [C[0] + (Math.cos(a) * len) / 2, C[1] + (Math.sin(a) * len) / 2];
      const barb = (s: number): P => [tip[0] - bl * Math.cos(a + s * spread), tip[1] - bl * Math.sin(a + s * spread)];
      return { pl: r() < 0.5 ? [tail, tip, barb(1)] : [tail, tip, barb(1), tip, barb(-1)], size: len, wobble: 0.008, step: 0.025 };
    },
  },
};

/** Letters and symbols at handwriting size (`s` ≈ half the glyph height, page units). */
const LETTERS: Record<string, (s: number) => P[]> = {
  o: (s) => ring(regularPts(40, s / 2, 0).map(([x, y]) => [x, C[1] + (y - C[1]) * 1.1] as P), 0.2, 1.05),
  zero: (s) => ring(regularPts(40, s / 2, 0).map(([x, y]) => [C[0] + (x - C[0]) * 0.6, y] as P), 0.75, 1.08),
  // Down the stem, back up, then the bowl round to the foot.
  D: (s) => [[C[0], C[1] - s], [C[0], C[1] + s], [C[0], C[1] - s], ...Array.from({ length: 25 }, (_, i) => [C[0] + s * 0.9 * Math.sin((i / 24) * Math.PI), C[1] - s * Math.cos((i / 24) * Math.PI)] as P)],
  // The stem and bowl in one stroke, from the top of the stem.
  'D (one loop)': (s) => [[C[0], C[1] - s], ...Array.from({ length: 25 }, (_, i) => [C[0] + s * 0.9 * Math.sin((i / 24) * Math.PI), C[1] - s * Math.cos((i / 24) * Math.PI)] as P), [C[0], C[1] - s]],
  integral: (s) => [[C[0] + s * 0.4, C[1] - s * 1.2], [C[0] + s * 0.2, C[1] - s * 1.35], [C[0], C[1] - s * 1.1], [C[0], C[1] + s * 1.1], [C[0] - s * 0.2, C[1] + s * 1.35], [C[0] - s * 0.4, C[1] + s * 1.2]],
};

const N_REAL = 40;

function tally(gen: (r: () => number) => Real, salt: number): Record<string, number> {
  const got: Record<string, number> = {};
  for (let i = 0; i < N_REAL; i++) {
    const { pl, size, wobble, step } = gen(rng(7000 + i * 13 + salt));
    const k = recognizeShape(quick(pl, size, i + 900 + salt, { wobble, step }))?.kind ?? 'none';
    got[k] = (got[k] ?? 0) + 1;
  }
  return got;
}

describe('recognizeShape: real hands, live hold', () => {
  for (const [name, { want, gen }] of Object.entries(REAL)) {
    it(`recognises a ${name} (≥ 90% of ${N_REAL}, never the wrong shape more than twice)`, () => {
      const got = tally(gen, name.length);
      if ((globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.SHAPE_DEBUG) console.log(name, JSON.stringify(got));
      expect(got[want] ?? 0).toBeGreaterThanOrEqual(Math.ceil(N_REAL * 0.9));
      const wrong = Object.entries(got).filter(([k]) => k !== want && k !== 'none').reduce((n, [, v]) => n + v, 0);
      expect(wrong).toBeLessThanOrEqual(2);
    });
  }

  it('letters and symbols (o, 0, D, ∫) never snap unless held', () => {
    for (const [name, gen] of Object.entries(LETTERS)) {
      for (const s of [8, 12, 18]) {
        const pts = quick(gen(s), 2 * s, s * 31 + name.length, { wobble: 0.02, step: 0.1 });
        expect([name, s, snapShape(pts, 0)]).toEqual([name, s, null]);
        expect([name, s, snapShape(pts, SNAP_HOLD_MS - 1)]).toEqual([name, s, null]);
      }
    }
  });

  it('a held D or ∫ is still not a shape', () => {
    for (const name of ['D', 'D (one loop)', 'integral']) {
      for (const s of [12, 18, 40]) {
        const got = recognizeShape(quick(LETTERS[name]!(s), 2 * s, s, { wobble: 0.015, step: 0.08 }))?.kind ?? null;
        expect([name, s, got]).toEqual([name, s, null]);
      }
    }
  });

  it('the hold is 400 ms within 2.5 mm', () => {
    expect(SNAP_HOLD_MS).toBe(400);
    expect(SNAP_HOLD_TOLERANCE_MM).toBe(2.5);
  });
});

describe('adjustShape: dragging after the snap', () => {
  const line = (a: P, b: P, kind: ShapeItem['kind'] = 'line'): ShapeItem => ({ id: 'l', type: 'shape', kind, pts: [a, b], color: '#000', width: 2 });
  const centre = (pts: P[]): P => [pts.reduce((m, p) => m + p[0], 0) / pts.length, pts.reduce((m, p) => m + p[1], 0) / pts.length];
  const len = (a: P, b: P) => Math.hypot(b[0] - a[0], b[1] - a[1]);

  it('a line: the end under the pen follows it, the other end stays', () => {
    const s = line([100, 100], [200, 130]);
    const out = adjustShape(s, [200, 130], [300, 200]);
    expect(out[0]).toEqual([100, 100]);
    expect(out[1]![0]).toBeCloseTo(300, 6);
    expect(out[1]![1]).toBeCloseTo(200, 6);
    // The pen near the first end moves that one, by the pen's offset (no jump to the pen).
    const back = adjustShape(s, [102, 99], [50, 50]);
    expect(back[1]).toEqual([200, 130]);
    expect(back[0]![0]).toBeCloseTo(48, 6);
    expect(back[0]![1]).toBeCloseTo(51, 6);
  });

  it('a line still snaps to horizontal and vertical within 5°', () => {
    const s = line([100, 100], [200, 100]);
    const h = adjustShape(s, [200, 100], [300, 106]); // 3°
    expect(h[1]![1]).toBeCloseTo(100, 6);
    expect(h[1]![0]).toBeCloseTo(100 + Math.hypot(200, 6), 6);
    const v = adjustShape(s, [200, 100], [108, 250]); // ~3° off straight down from the fixed end
    expect(v[1]![0]).toBeCloseTo(100, 6);
    const d = adjustShape(s, [200, 100], [200, 200]); // 45°: unchanged
    expect(d[1]![0]).toBeCloseTo(200, 6);
    expect(d[1]![1]).toBeCloseTo(200, 6);
  });

  it('an arrow keeps its direction: the tip follows the pen', () => {
    const out = adjustShape(line([100, 100], [200, 100], 'arrow'), [200, 100], [250, 160]);
    expect(out[0]).toEqual([100, 100]);
    expect(out[1]![0]).toBeCloseTo(250, 6);
    expect(out[1]![1]).toBeCloseTo(160, 6);
  });

  it('a circle scales about its centre and stays round', () => {
    const c = recognizeShape(quick(ring(regularPts(90, 80, 0), 0, 1.05), 160, 4))!;
    expect(c.kind).toBe('ellipse');
    const [cx, cy] = centre(c.pts);
    const from = c.pts[0]!;
    const to: P = [cx + (from[0] - cx) * 1.5 + 20, cy + (from[1] - cy) * 1.5 - 13];
    const out = adjustShape(c, from, to);
    expect(len(out[0]!, out[1]!)).toBeCloseTo(len(out[1]!, out[2]!), 6);
    expect(len(out[0]!, out[1]!) / len(c.pts[0]!, c.pts[1]!)).toBeGreaterThan(1.4);
    const [ox, oy] = centre(out);
    expect(ox).toBeCloseTo(cx, 6);
    expect(oy).toBeCloseTo(cy, 6);
  });

  it('a square stays square and upright for small turns; a bigger turn rotates it', () => {
    const sq: ShapeItem = { id: 's', type: 'shape', kind: 'rect', pts: [[100, 100], [200, 100], [200, 200], [100, 200]], color: '#000', width: 2 };
    const small = adjustShape(sq, [200, 200], [262, 268]); // ~2.6° turn, ×1.3
    expect(small[0]![1]).toBeCloseTo(small[1]![1], 6);
    expect(len(small[0]!, small[1]!)).toBeCloseTo(len(small[1]!, small[2]!), 6);
    expect(len(small[0]!, small[1]!)).toBeGreaterThan(125);
    const big = adjustShape(sq, [200, 200], [150, 150 + 50 * Math.SQRT2]); // 45° about the centre (150, 150)
    expect(Math.atan2(big[1]![1] - big[0]![1], big[1]![0] - big[0]![0]) / DEG).toBeCloseTo(45, 4);
    expect(len(big[0]!, big[1]!)).toBeCloseTo(100, 4);
    expect(adjustShape(sq, [200, 200], [200, 200])).toEqual(sq.pts);
  });

  it('a turned rectangle brought back near upright comes upright', () => {
    const r: ShapeItem = { id: 'r', type: 'shape', kind: 'rect', pts: ([[-60, -30], [60, -30], [60, 30], [-60, 30]] as P[]).map((p) => rot([C[0] + p[0], C[1] + p[1]], 20 * DEG, C)), color: '#000', width: 2 };
    const out = adjustShape(r, r.pts[2]!, rot(r.pts[2]!, -17 * DEG, C));
    expect(out[0]![1]).toBeCloseTo(out[1]![1], 6);
  });
});
