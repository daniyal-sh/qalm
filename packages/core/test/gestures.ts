// Real-looking pen input for gesture tests: polylines in mm traced at a pen's speed and sample rate (240 Hz), with
// rounded corners and a little hand jitter, as page-unit InkPoints. Seeded, so tests are deterministic.
import { UNITS_PER_MM, type InkPoint } from '../src';

type P = [number, number];

/** A tiny seeded PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Rounds each corner of a polyline (mm) with a curve `r` mm either side of it (never more than a third of a leg). */
export function roundCorners(pl: P[], r: number): P[] {
  if (pl.length < 3 || r <= 0) return pl;
  const out: P[] = [pl[0]!];
  for (let i = 1; i < pl.length - 1; i++) {
    const a = pl[i - 1]!, b = pl[i]!, c = pl[i + 1]!;
    const la = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const lc = Math.hypot(c[0] - b[0], c[1] - b[1]);
    const ca = Math.min(r, la / 3), cc = Math.min(r, lc / 3);
    const p0: P = [b[0] + ((a[0] - b[0]) * ca) / la, b[1] + ((a[1] - b[1]) * ca) / la];
    const p2: P = [b[0] + ((c[0] - b[0]) * cc) / lc, b[1] + ((c[1] - b[1]) * cc) / lc];
    for (let k = 0; k <= 6; k++) {
      const t = k / 6;
      const u = 1 - t;
      out.push([u * u * p0[0] + 2 * u * t * b[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * b[1] + t * t * p2[1]]);
    }
  }
  out.push(pl[pl.length - 1]!);
  return out;
}

/** An arc (mm, y down): centre, radius, from angle a0 to a1 (radians). */
export function arc(cx: number, cy: number, r: number, a0: number, a1: number, n = 12): P[] {
  return Array.from({ length: n + 1 }, (_, k) => {
    const a = a0 + ((a1 - a0) * k) / n;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as P;
  });
}

export interface TraceOpts {
  /** Where the polyline's (0, 0) goes on the page, in page units. */
  at?: P;
  /** mm/s along the path. */
  speed?: number;
  /** Hand jitter, mm (each sample). */
  jitter?: number;
  seed?: number;
  /** Turn the whole thing (radians) about its (0, 0). */
  rotate?: number;
  hz?: number;
}

/** Traces a polyline in mm at `speed`, sampled at `hz`, into page-unit InkPoints (pressure varies a little). */
export function trace(pl: P[], o: TraceOpts = {}): InkPoint[] {
  const speed = o.speed ?? 35;
  const hz = o.hz ?? 240;
  const rand = rng(o.seed ?? 1);
  const [ax, ay] = o.at ?? [100, 100];
  const cos = Math.cos(o.rotate ?? 0), sin = Math.sin(o.rotate ?? 0);
  const step = speed / hz; // mm per sample
  const out: InkPoint[] = [];
  const push = (x: number, y: number) => {
    const jx = (rand() - 0.5) * 2 * (o.jitter ?? 0.05);
    const jy = (rand() - 0.5) * 2 * (o.jitter ?? 0.05);
    const X = (x + jx) * cos - (y + jy) * sin;
    const Y = (x + jx) * sin + (y + jy) * cos;
    out.push({ x: ax + X * UNITS_PER_MM, y: ay + Y * UNITS_PER_MM, p: 0.45 + 0.2 * rand(), tilt: 1.1, az: 0.4, t: (out.length * 1000) / hz });
  };
  push(pl[0]![0], pl[0]![1]);
  let carry = 0;
  for (let i = 1; i < pl.length; i++) {
    const a = pl[i - 1]!, b = pl[i]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let t = step - carry;
    while (t <= len) {
      push(a[0] + ((b[0] - a[0]) * t) / len, a[1] + ((b[1] - a[1]) * t) / len);
      t += step;
    }
    carry = len - (t - step);
  }
  const z = pl[pl.length - 1]!;
  push(z[0], z[1]);
  return out;
}

/**
 * A back-and-forth scribble (mm): `legs` legs of about `leg` mm, each moving on by `advance` mm across them, the
 * corners rounded by 0.4 mm, leg lengths varied by `vary` (a share), starting at (0, 0) and running along +x.
 */
export function zigzag(leg: number, advance: number, legs: number, vary = 0.15, seed = 7): P[] {
  const rand = rng(seed);
  const pl: P[] = [[0, 0]];
  let y = 0;
  for (let i = 0; i < legs; i++) {
    y += advance;
    const l = leg * (1 - vary / 2 + vary * rand());
    const off = (rand() - 0.5) * leg * vary * 0.5;
    pl.push([i % 2 === 0 ? l + off : off, y]);
  }
  return roundCorners(pl, 0.4);
}

// ---- handwriting (mm, x-height h, y down, starting at the top-left of the first letter) ----

/** "m" in print: a stem, retraced, then two arches (`n` humps for "mmm"-like runs). */
export function mPrint(h: number, humps = 2): P[] {
  const w = h * 0.55;
  const pl: P[] = [[0, 0], [0, h], [0, h * 0.35]];
  for (let i = 0; i < humps; i++) {
    const x = i * w;
    pl.push(...arc(x + w / 2, h * 0.35, w / 2, Math.PI, 2 * Math.PI).slice(1), [x + w, h]);
    if (i < humps - 1) pl.push([x + w, h * 0.35]);
  }
  return pl;
}

/** Cursive "m"s joined: each letter's entry stroke, then its humps, with no pen lift ("mmm"). */
export function mCursive(h: number, letters: number): P[] {
  const pl: P[] = [];
  let x = 0;
  for (let l = 0; l < letters; l++) {
    pl.push([x, h], [x + h * 0.2, h * 0.3]);
    x += h * 0.2;
    for (let k = 0; k < (l === letters - 1 ? 3 : 3); k++) {
      const w = h * 0.5;
      pl.push(...arc(x + w / 2, h * 0.3, w / 2, Math.PI, 2 * Math.PI).slice(1), [x + w, h]);
      x += w;
      if (k < 2) pl.push([x, h * 0.4]);
    }
  }
  return pl;
}

/** "w" in print, `n` letters joined. */
export function wPrint(h: number, n = 1): P[] {
  const pl: P[] = [];
  for (let i = 0; i < n; i++) {
    const x = i * h * 1.3;
    pl.push([x, 0], [x + h * 0.3, h], [x + h * 0.6, h * 0.25], [x + h * 0.9, h], [x + h * 1.2, 0]);
  }
  return roundCorners(pl, 0.3);
}

/** Capital "M"s (cap height h), joined at the baseline. */
export function capitalM(h: number, n = 3): P[] {
  const pl: P[] = [];
  for (let i = 0; i < n; i++) {
    const x = i * h * 1.05;
    pl.push([x, h], [x, 0], [x + h * 0.4, h * 0.65], [x + h * 0.8, 0], [x + h * 0.8, h]);
  }
  return roundCorners(pl, 0.3);
}

/** "N"s or "Z"s, joined. */
export function capitalN(h: number, n = 3): P[] {
  const pl: P[] = [];
  for (let i = 0; i < n; i++) {
    const x = i * h * 0.95;
    pl.push([x, h], [x, 0], [x + h * 0.7, h], [x + h * 0.7, 0]);
  }
  return roundCorners(pl, 0.3);
}
export function capitalZ(h: number, n = 3): P[] {
  const pl: P[] = [];
  for (let i = 0; i < n; i++) {
    const x = i * h * 0.95;
    pl.push([x, 0], [x + h * 0.7, 0], [x, h], [x + h * 0.7, h]);
  }
  return roundCorners(pl, 0.3);
}

/** Loops: "eee" (small) or "lll" (tall). */
export function loops(h: number, n: number, tall = false): P[] {
  const pl: P[] = [[0, h]];
  let x = 0;
  for (let i = 0; i < n; i++) {
    const r = h * (tall ? 0.28 : 0.35);
    const top = tall ? h * 0.25 : h * 0.4;
    pl.push(...arc(x + r, top + r, r, Math.PI * 0.75, -Math.PI * 1.25 + 0.0001 - Math.PI * 0.0, 16));
    x += r * 1.6;
    pl.push([x + r * 0.4, h]);
  }
  return pl;
}

export function sine(amp: number, period: number, periods: number): P[] {
  const n = periods * 24;
  return Array.from({ length: n + 1 }, (_, k) => [(k / 24) * period, amp * Math.sin((k / 24) * 2 * Math.PI)] as P);
}

export function spiral(r: number, turns: number): P[] {
  const n = turns * 32;
  return Array.from({ length: n + 1 }, (_, k) => {
    const a = (k / 32) * 2 * Math.PI;
    const rr = (r * k) / n;
    return [rr * Math.cos(a), rr * Math.sin(a)] as P;
  });
}

/** An "8" (two loops). */
export function eight(h: number): P[] {
  return [...arc(0, h * 0.25, h * 0.25, Math.PI / 2, Math.PI / 2 + 2 * Math.PI, 24), ...arc(0, h * 0.75, h * 0.25, -Math.PI / 2, -Math.PI / 2 - 2 * Math.PI, 24)];
}
