// Handwriting as real ink: single-line font glyphs (EMS fonts, SIL OFL, see fonts/README.md) turned into qalm pen
// strokes with a natural hand: slant, baseline drift, size and spacing jitter, a slight tremor, pressure that ramps in
// and out and is heavier on downstrokes, and per-point timestamps from a pen speed that slows on curves.
// Everything is seeded, so a run reproduces the same ink.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** mulberry32 */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Roughly normal, mean 0, sd 1. */
const gauss = (r) => (r() + r() + r() + r() - 2) * 1.2247;

// ---------------------------------------------------------------------------------------------------- font loading

function flattenCubic(out, p0, p1, p2, p3, n = 10) {
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ]);
  }
}

/** SVG path data (M L H V C S Q Z, absolute or relative) as polylines. */
export function parsePath(d) {
  const toks = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? [];
  const paths = [];
  let cur = null, cmd = '', i = 0, x = 0, y = 0, sx = 0, sy = 0, lc = null;
  const num = () => +toks[i++];
  while (i < toks.length) {
    if (/[a-zA-Z]/.test(toks[i])) cmd = toks[i++];
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const ox = rel ? x : 0, oy = rel ? y : 0;
    if (C === 'M') {
      x = ox + num(); y = oy + num(); sx = x; sy = y;
      cur = [[x, y]]; paths.push(cur);
      cmd = rel ? 'l' : 'L'; lc = null;
    } else if (C === 'L') { x = ox + num(); y = oy + num(); cur.push([x, y]); lc = null; }
    else if (C === 'H') { x = (rel ? x : 0) + num(); cur.push([x, y]); lc = null; }
    else if (C === 'V') { y = (rel ? y : 0) + num(); cur.push([x, y]); lc = null; }
    else if (C === 'C' || C === 'S') {
      let c1;
      if (C === 'C') c1 = [ox + num(), oy + num()];
      else c1 = lc ? [2 * x - lc[0], 2 * y - lc[1]] : [x, y];
      const c2 = [ox + num(), oy + num()];
      const e = [ox + num(), oy + num()];
      flattenCubic(cur, [x, y], c1, c2, e);
      lc = c2; x = e[0]; y = e[1];
    } else if (C === 'Q') {
      const c = [ox + num(), oy + num()];
      const e = [ox + num(), oy + num()];
      flattenCubic(cur, [x, y], [x + (2 / 3) * (c[0] - x), y + (2 / 3) * (c[1] - y)], [e[0] + (2 / 3) * (c[0] - e[0]), e[1] + (2 / 3) * (c[1] - e[1])], e);
      x = e[0]; y = e[1]; lc = null;
    } else if (C === 'Z') { cur.push([sx, sy]); x = sx; y = sy; lc = null; if (i < toks.length && !/[a-zA-Z]/.test(toks[i])) i++; }
    else i++;
  }
  return paths.filter((p) => p.length > 1);
}

const ENT = { amp: '&', quot: '"', lt: '<', gt: '>', apos: "'" };
const decode = (s) => s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&(\w+);/g, (m, e) => ENT[e] ?? m);
const attr = (tag, name) => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? m[1] : undefined;
};

/**
 * Extra glyphs the fonts lack (maths), as centerline paths in the fonts' units: baseline 0, y up, x-height 300.
 * Drawn to sit with Casual Hand.
 */
const EXTRA = {
  '∫': { adv: 260, d: 'M 250 760 C 200 790 150 760 140 640 L 120 40 C 110 -110 60 -150 10 -110' },
  'π': { adv: 360, d: 'M 20 260 C 80 300 250 300 340 300 M 120 290 C 115 180 100 80 70 0 M 250 295 C 245 180 250 60 300 0' },
  'θ': { adv: 300, d: 'M 150 520 C 40 520 20 260 40 120 C 60 -20 240 -20 260 140 C 280 300 250 520 150 520 M 40 260 L 265 270' },
  'Δ': { adv: 420, d: 'M 210 520 L 20 0 L 400 0 Z' },
  '→': { adv: 520, d: 'M 20 160 C 160 165 330 160 480 158 M 380 240 C 420 200 450 175 485 158 C 450 140 420 115 385 80' },
  '⇒': { adv: 520, d: 'M 20 200 L 440 200 M 20 120 L 440 120 M 370 270 L 485 160 L 370 50' },
  '√': { adv: 380, d: 'M 0 200 L 60 240 L 150 0 L 260 560 L 380 560' },
  '∞': { adv: 460, d: 'M 230 150 C 150 300 30 260 30 150 C 30 40 150 0 230 150 C 310 300 430 260 430 150 C 430 40 310 0 230 150' },
  'λ': { adv: 340, d: 'M 40 560 C 100 560 130 450 170 300 L 300 0 M 175 280 L 40 0' },
  'μ': { adv: 330, d: 'M 50 300 L 30 -200 M 50 300 C 50 100 80 0 160 10 C 240 20 270 120 280 300 M 280 300 L 285 0' },
  'ω': { adv: 430, d: 'M 70 280 C 10 150 50 0 130 10 C 190 20 210 120 210 180 C 210 120 230 20 290 10 C 370 0 410 150 350 280' },
  'α': { adv: 360, d: 'M 300 270 C 260 70 180 -10 100 10 C 20 30 20 280 120 290 C 230 300 260 100 330 0' },
  '≈': { adv: 360, d: 'M 20 210 C 80 270 140 150 200 210 C 260 270 300 220 330 210 M 20 110 C 80 170 140 50 200 110 C 260 170 300 120 330 110' },
  '≠': { adv: 360, d: 'M 30 210 L 330 210 M 30 110 L 330 110 M 250 300 L 110 20' },
  '≤': { adv: 360, d: 'M 320 330 L 40 230 L 320 130 M 40 60 L 320 60' },
  '✓': { adv: 380, d: 'M 20 160 C 60 120 100 70 130 0 C 190 170 270 330 370 470' },
  '•': { adv: 200, d: 'M 100 170 C 70 170 60 140 70 120 C 80 100 120 100 130 125 C 140 150 120 170 95 165' },
  '★': { adv: 400, d: 'M 200 480 L 255 330 L 400 320 L 285 220 L 330 60 L 200 160 L 70 60 L 115 220 L 0 320 L 145 330 Z' },
  '∂': { adv: 320, d: 'M 70 470 C 160 560 280 520 280 300 C 280 100 210 0 130 0 C 50 0 30 80 40 140 C 60 230 160 260 270 220' },
};

/** Casual Hand glyphs drawn as one zig-zag stroke (the crossbar goes out and back), redrawn as stem + bar. */
const FIXES = {
  t: { adv: 300, d: 'M 112 508 L 125 250 L 147 13 M 36 282 L 282 312' },
  f: { adv: 184, d: 'M 148 518 L 119 518 L 91 508 L 68 471 L 62 312 L 75 0 M 12 270 L 180 285' },
};

const fonts = new Map();
/** A font from `fonts/` (`EMSCasualHand`, `EMSAllure`): glyph polylines in font units, baseline 0, y up. */
export function loadFont(name) {
  if (fonts.has(name)) return fonts.get(name);
  const src = readFileSync(fileURLToPath(new URL(`./fonts/${name}.svg`, import.meta.url)), 'utf8');
  const fontTag = /<font\s[^>]*>/.exec(src)[0];
  const face = /<font-face[^>]*>/s.exec(src)[0];
  const xh = +(attr(face, 'x-height') ?? 300);
  const defAdv = +(attr(fontTag, 'horiz-adv-x') ?? 500);
  const glyphs = new Map();
  for (const m of src.matchAll(/<glyph\s[^>]*?\/>/gs)) {
    const tag = m[0];
    const u = attr(tag, 'unicode');
    if (u === undefined) continue;
    const ch = decode(u);
    if ([...ch].length !== 1) continue;
    glyphs.set(ch, { adv: +(attr(tag, 'horiz-adv-x') ?? defAdv), paths: parsePath(attr(tag, 'd') ?? '') });
  }
  // The fonts' declared x-height (300) is not what their glyphs use: measure it from the tops of x u v n z.
  const tops = ['x', 'u', 'v', 'n', 'z'].map((c) => Math.max(...(glyphs.get(c)?.paths.flat().map((p) => p[1]) ?? [xh]))).sort((a, b) => a - b);
  const realXh = tops[2];
  const k = realXh / 300;
  const fixes = name === 'EMSCasualHand' ? FIXES : {};
  for (const [ch, g] of Object.entries({ ...EXTRA, ...fixes })) {
    if (glyphs.has(ch) && !(ch in fixes)) continue;
    glyphs.set(ch, { adv: g.adv * k, paths: parsePath(g.d).map((p) => p.map(([x, y]) => [x * k, y * k])) });
  }
  const f = { name, xh: realXh, glyphs, space: glyphs.get(' ')?.adv ?? defAdv };
  fonts.set(name, f);
  return f;
}

// ---------------------------------------------------------------------------------------------------- geometry

function resample(pts, step) {
  const out = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
    const len = Math.hypot(bx - ax, by - ay);
    if (!len) continue;
    let d = step - carry;
    while (d <= len) {
      const t = d / len;
      out.push([ax + (bx - ax) * t, ay + (by - ay) * t]);
      d += step;
    }
    carry = len - (d - step);
  }
  const last = pts[pts.length - 1];
  const l = out[out.length - 1];
  if (Math.hypot(last[0] - l[0], last[1] - l[1]) > step * 0.3) out.push(last);
  else out[out.length - 1] = last;
  return out;
}

/** Chaikin corner cutting, ends kept: rounds the font's polyline corners the way a moving pen does. */
function chaikin(pts, passes) {
  let p = pts;
  for (let k = 0; k < passes; k++) {
    if (p.length < 3) return p;
    const out = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      const [ax, ay] = p[i], [bx, by] = p[i + 1];
      out.push([0.75 * ax + 0.25 * bx, 0.75 * ay + 0.25 * by], [0.25 * ax + 0.75 * bx, 0.25 * ay + 0.75 * by]);
    }
    out.push(p[p.length - 1]);
    p = out;
  }
  return p;
}

const smooth01 = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/**
 * Turns a page-space polyline into qalm InkPoints: resampled like a digitiser, with tremor, a pressure curve and
 * timestamps. `o.speed` is in page units per ms.
 */
export function inkPoints(poly, r, o = {}) {
  const step = o.step ?? 0.55;
  const pts = resample(poly, step);
  const n = pts.length;
  // arc length
  const s = [0];
  for (let i = 1; i < n; i++) s.push(s[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const L = s[n - 1] || 1;
  const base = o.pressure ?? 0.58;
  const ph = r() * 6.28;
  const tremor = o.tremor ?? 0.06;
  const tilt = (o.tilt ?? 0.95) + gauss(r) * 0.04;
  const az = (o.az ?? 0.7) + gauss(r) * 0.05;
  const speed = (o.speed ?? 0.13) * (0.85 + r() * 0.3);
  const rampIn = Math.min(2.2, L * 0.22), rampOut = Math.min(3, L * 0.3);
  const out = [];
  let t = 0;
  for (let i = 0; i < n; i++) {
    const prev = pts[Math.max(0, i - 1)], next = pts[Math.min(n - 1, i + 1)];
    const dx = next[0] - prev[0], dy = next[1] - prev[1];
    const dl = Math.hypot(dx, dy) || 1;
    // turning: 0 straight .. 1 sharp
    let turn = 0;
    if (i > 0 && i < n - 1) {
      const ax = pts[i][0] - prev[0], ay = pts[i][1] - prev[1], bx = next[0] - pts[i][0], by = next[1] - pts[i][1];
      const la = Math.hypot(ax, ay) || 1, lb = Math.hypot(bx, by) || 1;
      turn = Math.min(1, (1 - (ax * bx + ay * by) / (la * lb)) * 1.5);
    }
    const down = dy / dl; // page y grows downwards: + is a downstroke
    let p = base + 0.11 * down + 0.05 * Math.sin(s[i] * 0.23 + ph) + 0.08 * turn;
    p *= 0.35 + 0.65 * smooth01(s[i] / (rampIn || 1));
    p *= 0.4 + 0.6 * smooth01((L - s[i]) / (rampOut || 1));
    p = Math.max(0.12, Math.min(0.95, p));
    if (i > 0) t += (s[i] - s[i - 1]) / (speed * (1 - 0.55 * turn) * (0.55 + 0.45 * smooth01(s[i] / 4)));
    const jx = i === 0 || i === n - 1 ? 0 : gauss(r) * tremor;
    const jy = i === 0 || i === n - 1 ? 0 : gauss(r) * tremor;
    out.push({ x: pts[i][0] + jx, y: pts[i][1] + jy, p, tilt, az, t: Math.round(t * 10) / 10 });
  }
  return out;
}

export function bboxOf(points, width) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const q of points) {
    if (q.x < x0) x0 = q.x;
    if (q.y < y0) y0 = q.y;
    if (q.x > x1) x1 = q.x;
    if (q.y > y1) y1 = q.y;
  }
  const h = width / 2;
  return [x0 - h, y0 - h, x1 + h, y1 + h];
}

// ---------------------------------------------------------------------------------------------------- the hand

/** Characters of a line; `^{…}` raises (superscript) and `_{…}` lowers (subscript) what's inside. */
function tokens(text) {
  const out = [];
  for (let i = 0; i < text.length; ) {
    const m = /^([^_]){([^}]*)}/.exec(text.slice(i));
    if (m) {
      for (const ch of m[2]) out.push({ ch, sup: m[1] === '^' ? 1 : -1 });
      i += m[0].length;
      continue;
    }
    const ch = String.fromCodePoint(text.codePointAt(i));
    out.push({ ch, sup: 0 });
    i += ch.length;
  }
  return out;
}

let idSeq = 0;
/** Deterministic ids (`ink-<n>`), unique within a run. */
export const nextId = (p = 's') => `${p}${(++idSeq).toString(36).padStart(5, '0')}`;
export const resetIds = () => { idSeq = 0; };

/**
 * A writer. `clock` is shared by every Hand of a notebook so strokes get increasing `createdAt` times with pauses.
 * Sizes are in page units (A4 is 595 × 842): `xh` is the x-height.
 */
export class Hand {
  constructor({ font = 'EMSCasualHand', seed = 1, xh = 8.2, slant = 7, color = '#27272a', width = 1.25, style = 'fountain', smoothing = 2, clock, speed = 0.13 } = {}) {
    this.font = loadFont(font);
    this.r = rng(seed);
    this.xh = xh;
    this.slant = slant;
    this.color = color;
    this.width = width;
    this.style = style;
    this.smoothing = smoothing;
    this.speed = speed;
    this.clock = clock ?? { t: Date.UTC(2026, 10, 20, 9, 0) };
    this.cursive = font === 'EMSAllure';
  }

  with(o) {
    const h = Object.create(this);
    Object.assign(h, o);
    if (o.font) h.font = loadFont(o.font);
    return h;
  }

  stroke(poly, extra = {}) {
    const r = this.r;
    const points = inkPoints(poly, r, { speed: this.speed, ...extra });
    const width = extra.width ?? this.width;
    const at = this.clock.t;
    this.clock.t += Math.round(points[points.length - 1].t + 90 + r() * 140);
    return {
      id: nextId(),
      type: 'stroke',
      tool: 'pen',
      color: extra.color ?? this.color,
      width,
      points,
      bbox: bboxOf(points, width),
      createdAt: at,
      style: this.style,
      smoothing: this.smoothing,
    };
  }

  pause(ms) {
    this.clock.t += ms;
  }

  /**
   * Writes one line of text with its baseline at `y`, starting at `x`. Returns `{ items, x, bbox }` (`x`: where the
   * pen stopped). Options: `size` (× x-height), `color`, `width`, `track` (letter spacing ×), `drift` (baseline drift ×).
   */
  write(text, x, y, o = {}) {
    const r = this.r;
    const f = this.font;
    const size = (o.size ?? 1) * this.xh;
    const k0 = size / f.xh;
    const color = o.color ?? this.color;
    const width = o.width ?? this.width * Math.min(1.25, Math.max(0.8, Math.sqrt(o.size ?? 1)));
    const shear = Math.tan(((this.slant + gauss(r) * 0.6) * Math.PI) / 180);
    const tiltLine = gauss(r) * 0.006; // the whole line runs slightly up or down
    const driftAmp = (o.drift ?? 1) * size * 0.06;
    const ph1 = r() * 6.28, ph2 = r() * 6.28;
    const items = [];
    let cx = x;
    let wordScale = 1;
    let prevEnd = null; // cursive joins
    let pending = null;
    const flush = () => {
      if (pending) items.push(this.stroke(pending, { width, color, pressure: o.pressure }));
      pending = null;
    };
    const chars = tokens(text);
    for (let ci = 0; ci < chars.length; ci++) {
      const { ch, sup } = chars[ci];
      if (ch === ' ') {
        flush();
        prevEnd = null;
        cx += f.space * k0 * (o.wordSpace ?? 0.95) * (0.9 + r() * 0.25);
        wordScale = 1 + gauss(r) * 0.025;
        this.pause(180 + r() * 260);
        continue;
      }
      const g = f.glyphs.get(ch) ?? f.glyphs.get('?');
      const k = k0 * wordScale * (1 + gauss(r) * 0.035) * (sup ? 0.7 : 1);
      const rot = gauss(r) * 0.022;
      const gdy = gauss(r) * size * 0.035;
      const cos = Math.cos(rot), sin = Math.sin(rot);
      const dx = cx - x;
      const baseY = y - (sup === 1 ? size * 0.95 : sup === -1 ? -size * 0.35 : 0) + tiltLine * dx + driftAmp * (Math.sin(dx * 0.021 + ph1) + 0.5 * Math.sin(dx * 0.057 + ph2)) + gdy;
      const map = ([gx, gy]) => {
        const lx = gx * k, ly = gy * k; // font units → page units, y still up
        const sx = lx * cos - ly * sin, sy = lx * sin + ly * cos;
        return [cx + sx + sy * shear, baseY - sy];
      };
      for (let pi = 0; pi < g.paths.length; pi++) {
        let poly = chaikin(g.paths[pi].map(map), 2);
        // Cursive: join to the previous glyph's last stroke when they meet.
        if (this.cursive && pi === 0 && pending && prevEnd && Math.hypot(poly[0][0] - prevEnd[0], poly[0][1] - prevEnd[1]) < size * 0.35) {
          pending = pending.concat(poly.slice(1));
        } else {
          flush();
          pending = poly;
        }
        prevEnd = pending[pending.length - 1];
      }
      if (!this.cursive) flush();
      cx += g.adv * k * (o.track ?? 1) * (1 + gauss(r) * 0.03);
      this.pause(20 + r() * 60);
    }
    flush();
    let bbox = null;
    for (const it of items) bbox = bbox ? [Math.min(bbox[0], it.bbox[0]), Math.min(bbox[1], it.bbox[1]), Math.max(bbox[2], it.bbox[2]), Math.max(bbox[3], it.bbox[3])] : [...it.bbox];
    this.pause(500 + r() * 900);
    return { items, x: cx, bbox: bbox ?? [x, y, x, y] };
  }

  /** Width of `text` at this hand's size, without writing it (for centring and right-aligning). */
  measure(text, o = {}) {
    const f = this.font;
    const k0 = ((o.size ?? 1) * this.xh) / f.xh;
    let w = 0;
    for (const { ch, sup } of tokens(text)) w += (sup ? 0.7 : 1) * ch === ' ' ? f.space * k0 * (o.wordSpace ?? 0.95) * 1.02 : (f.glyphs.get(ch)?.adv ?? 0) * k0 * (o.track ?? 1);
    return w;
  }

  // ---- marks: freehand lines, loops and arrows, drawn as pen strokes ----

  /** A slightly bowed hand-drawn line from a to b. */
  line(a, b, o = {}) {
    const r = this.r;
    const bow = (o.bow ?? 0.012) * Math.hypot(b[0] - a[0], b[1] - a[1]) * (r() < 0.5 ? -1 : 1);
    const nx = -(b[1] - a[1]), ny = b[0] - a[0];
    const nl = Math.hypot(nx, ny) || 1;
    const poly = [];
    for (let i = 0; i <= 24; i++) {
      const t = i / 24;
      const bw = bow * Math.sin(Math.PI * t);
      poly.push([a[0] + (b[0] - a[0]) * t + (nx / nl) * bw, a[1] + (b[1] - a[1]) * t + (ny / nl) * bw]);
    }
    return this.stroke(poly, o);
  }

  /** A hand-drawn loop around a box (circling a term): one stroke that overshoots where it started. */
  loop(box, o = {}) {
    const r = this.r;
    const [x0, y0, x1, y1] = box;
    const pad = o.pad ?? 4;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const rx = (x1 - x0) / 2 + pad, ry = (y1 - y0) / 2 + pad * 0.8;
    const a0 = -2.4 + r() * 0.4;
    const span = Math.PI * 2 + 0.45 + r() * 0.25;
    const poly = [];
    for (let i = 0; i <= 64; i++) {
      const t = i / 64;
      const a = a0 + span * t;
      const grow = 1 + 0.07 * t + 0.02 * Math.sin(t * 9);
      poly.push([cx + Math.cos(a) * rx * grow, cy + Math.sin(a) * ry * grow - 1.2 * t]);
    }
    return this.stroke(poly, o);
  }

  /** A hand-drawn curved arrow from a to b (shaft, then a two-stroke head). `o.curve` bends it (± fraction of length). */
  arrow(a, b, o = {}) {
    const curve = o.curve ?? 0.18;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const nx = -(b[1] - a[1]) / len, ny = (b[0] - a[0]) / len;
    const c = [(a[0] + b[0]) / 2 + nx * curve * len, (a[1] + b[1]) / 2 + ny * curve * len];
    const poly = [];
    for (let i = 0; i <= 32; i++) {
      const t = i / 32, u = 1 - t;
      poly.push([u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]]);
    }
    const shaft = this.stroke(poly, o);
    // head along the end tangent
    const tx = b[0] - c[0], ty = b[1] - c[1];
    const tl = Math.hypot(tx, ty);
    const ux = tx / tl, uy = ty / tl;
    const hl = o.head ?? Math.min(9, 3 + len * 0.12);
    const wing = (s) => [b[0] - ux * hl * Math.cos(0.5) + s * -uy * hl * Math.sin(0.5), b[1] - uy * hl * Math.cos(0.5) + s * ux * hl * Math.sin(0.5)];
    const head = this.stroke([wing(1), [b[0] + ux * 0.4, b[1] + uy * 0.4], wing(-1)], o);
    return [shaft, head];
  }

  /** An underline under a box, a little longer than it, slightly wavy. */
  underline(box, o = {}) {
    const y = box[3] + (o.gap ?? 2.2);
    return this.line([box[0] - 2, y + this.r() * 0.8], [box[2] + 3, y - 0.6 + this.r() * 0.6], { bow: 0.008, ...o });
  }
}

/** A highlighter swipe over a box (one stroke, the app's highlighter: width 12 at 0.45 multiply). */
export function highlight(box, color, clock, seed = 1, o = {}) {
  const r = rng(seed);
  const [x0, y0, x1, y1] = box;
  const y = (y0 + y1) / 2 + (o.dy ?? 0);
  const width = o.width ?? Math.max(10, Math.min(14, (y1 - y0) * 1.05));
  const poly = [];
  for (let i = 0; i <= 20; i++) {
    const t = i / 20;
    poly.push([x0 - 2 + (x1 - x0 + 4) * t, y + Math.sin(t * 3 + r()) * 0.4 - t * 0.6]);
  }
  const points = inkPoints(poly, r, { speed: 0.3, tremor: 0.02 }).map((q) => ({ ...q, p: 0.5 }));
  const at = clock.t;
  clock.t += 600;
  return { id: nextId('h'), type: 'stroke', tool: 'highlighter', color, width, points, bbox: bboxOf(points, width), createdAt: at };
}
