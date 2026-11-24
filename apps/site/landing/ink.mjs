// Handwriting generator for the landing page. Glyph centerlines are hand-authored, then run through
// perfect-freehand with qalm's own fountain-pen settings (packages/core/src/geometry/stroke.ts).
import { getStroke } from 'perfect-freehand'; // the repo's own copy (packages/core depends on it)

// ---------- glyphs: em box, baseline 0, x-height -48, ascender -92, y down ----------
const BOWL = 'M33,-37 C26,-48 5,-45 3,-24 C1,-5 19,1 32,-16';
export const G = {
  x: { a: 42, s: ['M2,-44 C14,-38 24,-14 38,-1', 'M37,-46 C25,-32 13,-14 1,1'] },
  l: { a: 26, s: ['M0,-6 C12,-26 24,-62 22,-84 C21,-97 10,-96 9,-80 C7,-56 7,-24 11,-8 C13,0 20,1 27,-5'] },
  n: { a: 46, s: ['M1,-42 C3,-28 3,-14 2,0 C5,-22 13,-45 26,-44 C37,-43 35,-22 35,-9 C35,-2 39,1 44,-3'] },
  d: { a: 48, s: [BOWL, 'M35,-94 C34,-60 33,-26 35,-7 C36,0 41,1 46,-4'] },
  a: { a: 48, s: ['M33,-37 C26,-48 5,-45 3,-24 C1,-5 19,1 32,-16 C33,-26 34,-36 35,-45 C34,-30 33,-12 36,-4 C38,1 42,0 46,-4'] },
  q: { a: 46, s: [BOWL, 'M35,-46 C34,-20 34,8 35,32 C37,24 41,20 47,18'] },
  m: { a: 68, s: ['M1,-42 C3,-28 3,-14 2,0 C4,-22 10,-44 20,-44 C29,-44 28,-22 27,-2 C30,-24 37,-45 48,-44 C58,-43 56,-22 56,-9 C56,-2 60,1 65,-3'] },
  u: { a: 48, s: ['M1,-44 C0,-24 1,-4 14,-2 C26,0 33,-22 35,-44 C34,-26 34,-9 37,-3 C39,1 42,0 45,-3'] },
  v: { a: 40, s: ['M0,-45 C6,-30 11,-12 16,0 C21,-16 28,-34 37,-47'] },
  w: { a: 52, s: ['M0,-44 C2,-26 6,-8 12,-1 C17,-14 20,-28 23,-38 C26,-24 29,-10 35,-1 C41,-14 45,-30 47,-46'] },
  h: { a: 50, s: ['M2,-6 C12,-28 24,-64 22,-86 C21,-97 10,-96 9,-80 C8,-56 7,-24 6,0 C10,-24 18,-45 30,-44 C40,-43 38,-22 38,-9 C38,-2 42,1 47,-3'] },
  y: { a: 44, s: ['M1,-44 C0,-26 2,-8 14,-6 C24,-5 31,-24 34,-44 C33,-18 34,10 28,26 C22,40 6,36 4,26'] },
  '?': { a: 44, s: ['M3,-72 C6,-96 40,-96 38,-70 C37,-52 20,-50 20,-26', 'M20,-5 C20.5,-3.5 21,-2.5 21,-1.5'] },
  '=': { a: 44, s: ['M0,-31 C10,-32 24,-32 34,-31', 'M2,-14 C12,-15 26,-15 36,-14'] },
  '-': { a: 42, s: ['M0,-23 C10,-24 22,-24 32,-23'] },
  '+': { a: 44, s: ['M17,-41 C17,-30 16,-16 16,-5', 'M0,-23 C11,-24 23,-24 34,-23'] },
  C: { a: 48, s: ['M42,-78 C32,-94 6,-88 2,-50 C-1,-14 20,4 44,-12'] },
  '2': { a: 48, s: ['M3,-68 C7,-92 40,-94 39,-67 C38,-44 14,-22 1,0 C14,-3 30,-2 45,0'] },
  '4': { a: 50, s: ['M30,-92 C21,-70 9,-48 0,-28 C14,-29 30,-30 46,-31', 'M33,-64 C32,-44 31,-20 31,0'] },
  '∫': { a: 34, s: ['M42,-100 C37,-110 24,-108 23,-88 C22,-52 24,-12 19,10 C15,28 2,26 0,15'] },
  ',': { a: 16, s: ['M4,-4 C5,0 4,6 0,10'] },
  '✓': { a: 56, s: ['M0,-26 C6,-18 10,-10 14,0 C22,-28 34,-56 52,-80'] },
  e: { a: 40, s: ['M4,-22 C14,-20 30,-24 32,-34 C34,-46 14,-50 6,-38 C-2,-24 4,-2 18,-1 C26,0 32,-4 36,-8'] },
  c: { a: 38, s: ['M34,-38 C28,-48 8,-48 3,-30 C-1,-12 10,0 22,-1 C28,-1 33,-5 36,-9'] },
  o: { a: 40, s: ['M20,-46 C6,-46 0,-30 2,-18 C4,-4 16,0 24,-4 C34,-10 36,-30 30,-40 C26,-47 18,-48 12,-44'] },
  i: { a: 18, s: ['M4,-44 C4,-30 3,-14 5,-5 C6,0 10,1 14,-2', 'M6,-66 C6.4,-65 6.8,-64.4 7.4,-64'] },
  t: { a: 28, s: ['M10,-80 C10,-56 8,-24 10,-8 C11,0 18,1 24,-4', 'M0,-46 C8,-47 16,-47 25,-47'] },
  r: { a: 30, s: ['M2,-44 C3,-30 3,-14 2,0 C4,-24 12,-44 28,-42'] },
  s: { a: 36, s: ['M30,-40 C26,-48 8,-48 6,-38 C4,-28 30,-26 30,-12 C30,0 6,2 0,-8'] },
  g: { a: 46, s: [BOWL, 'M35,-46 C34,-20 35,6 30,22 C24,38 4,36 2,24'] },
  b: { a: 40, s: ['M2,-6 C10,-30 18,-66 16,-86 C15,-97 6,-96 5,-80 C4,-56 4,-24 4,-2 C8,-30 20,-48 32,-40 C40,-32 36,-6 22,-1 C14,2 8,-2 6,-6'] },
  p: { a: 40, s: ['M4,-44 C4,-20 3,8 3,32', 'M4,-34 C12,-48 34,-48 34,-26 C34,-6 16,0 4,-8'] },
  k: { a: 38, s: ['M2,-6 C12,-28 24,-64 22,-86 C21,-97 10,-96 9,-80 C8,-56 7,-24 6,0', 'M30,-44 C22,-36 14,-28 8,-22 C18,-18 26,-8 34,-1'] },
  f: { a: 30, s: ['M30,-86 C24,-98 10,-94 10,-74 C10,-40 10,0 8,28', 'M0,-44 C8,-45 18,-45 26,-45'] },
  I: { a: 26, s: ['M12,-90 C12,-60 11,-30 10,0'] },
  ':': { a: 18, s: ['M6,-36 C6.4,-35 6.8,-34.4 7.4,-34', 'M5,-8 C5.4,-7 5.8,-6.4 6.4,-6'] },
  '!': { a: 18, s: ['M8,-90 C8,-66 7,-40 7,-24', 'M6,-5 C6.4,-4 6.8,-3.4 7.4,-3'] },
  ' ': { a: 30, s: [] },
};

// ---------- tiny SVG path sampler (absolute M, L, C) ----------
function parse(d) {
  const toks = d.match(/[MLC]|-?\d*\.?\d+/g);
  const segs = [];
  let i = 0, cmd = '', cur = [0, 0];
  const num = () => parseFloat(toks[i++]);
  while (i < toks.length) {
    if (/[MLC]/.test(toks[i])) cmd = toks[i++];
    if (cmd === 'M') { cur = [num(), num()]; cmd = 'L'; segs.push({ t: 'M', p: cur }); }
    else if (cmd === 'L') { const p = [num(), num()]; segs.push({ t: 'L', a: cur, p }); cur = p; }
    else if (cmd === 'C') { const c1 = [num(), num()], c2 = [num(), num()], p = [num(), num()]; segs.push({ t: 'C', a: cur, c1, c2, p }); cur = p; }
  }
  return segs;
}
function sample(d, step = 0.5) {
  const pts = [];
  for (const s of parse(d)) {
    if (s.t === 'M') { pts.push(s.p); continue; }
    const f = s.t === 'L'
      ? (t) => [s.a[0] + (s.p[0] - s.a[0]) * t, s.a[1] + (s.p[1] - s.a[1]) * t]
      : (t) => { const u = 1 - t; return [0, 1].map((k) => u * u * u * s.a[k] + 3 * u * u * t * s.c1[k] + 3 * u * t * t * s.c2[k] + t * t * t * s.p[k]); };
    const N = 200;
    let prev = f(0), acc = 0;
    for (let j = 1; j <= N; j++) {
      const q = f(j / N);
      acc += Math.hypot(q[0] - prev[0], q[1] - prev[1]);
      if (acc >= step || j === N) { pts.push(q); acc = 0; }
      prev = q;
    }
  }
  return pts;
}

// ---------- seeded rng ----------
export function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

// ---------- pressure model: heavier on downstrokes and slow turns, light flicks at the end ----------
function withPressure(pts, rand, amp = 1) {
  const n = pts.length;
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 3)], b = pts[Math.min(n - 1, i + 3)];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    const down = Math.max(0, dy / len);
    const pa = pts[Math.max(0, i - 6)], pb = pts[Math.min(n - 1, i + 6)];
    const v1 = [p[0] - pa[0], p[1] - pa[1]], v2 = [pb[0] - p[0], pb[1] - p[1]];
    const turn = Math.abs(Math.atan2(v1[0] * v2[1] - v1[1] * v2[0], v1[0] * v2[0] + v1[1] * v2[1])) / Math.PI;
    const t = i / Math.max(1, n - 1);
    const end = Math.min(1, (1 - t) * 6); // ease off at the end
    const start = Math.min(1, t * 10 + 0.55);
    let pr = 0.36 + 0.3 * amp * down + 0.16 * amp * turn - 0.12 * (amp - 1);
    pr *= 0.55 + 0.45 * end;
    pr *= start;
    return [p[0], p[1], Math.max(0.12, Math.min(0.95, pr))];
  }).map((p, i, a) => {
    let sum = 0, k = 0;
    for (let j = Math.max(0, i - 3); j <= Math.min(a.length - 1, i + 3); j++) { sum += a[j][2]; k++; }
    return [p[0], p[1], sum / k];
  });
}

// qalm's stabilise (smoothing level 2: minStep 0.6, passes 2)
function stabilize(pts, minStep, passes) {
  const n = pts.length; if (n < 3) return pts;
  let out = [pts[0]]; const m2 = minStep * minStep;
  for (let i = 1; i < n - 1; i++) { const a = out[out.length - 1], b = pts[i]; if ((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2 >= m2) out.push(b); }
  out.push(pts[n - 1]);
  for (let k = 0; k < passes; k++) {
    const m = out.length; if (m < 3) break; const nx = [out[0]];
    for (let i = 1; i < m - 1; i++) { const a = out[i - 1], b = out[i], c = out[i + 1]; nx.push([0, 1, 2].map((j) => (a[j] + 2 * b[j] + c[j]) / 4)); }
    nx.push(out[m - 1]); out = nx;
  }
  return out;
}

export const STYLES = { fountain: { thinning: 0.6, curve: 1 }, ball: { thinning: 0.15, curve: 1 }, brush: { thinning: 0.75, curve: 0.6 } };

const f1 = (n) => (Math.round(n * 10) / 10).toString();
function rdp(pts, eps) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop(); const [ax, ay] = pts[i], [bx, by] = pts[j];
    const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1;
    let md = 0, mi = -1;
    for (let k = i + 1; k < j; k++) { const d = Math.abs((pts[k][0] - ax) * dy - (pts[k][1] - ay) * dx) / L; if (d > md) { md = d; mi = k; } }
    if (md > eps && mi > 0) { keep[mi] = 1; stack.push([i, mi], [mi, j]); }
  }
  return pts.filter((_, k) => keep[k]);
}
function outlinePath(raw) {
  const pts = rdp(raw, 0.18);
  const n = pts.length;
  if (n < 4) return `M${pts.map(([x, y]) => `${f1(x)},${f1(y)}`).join('L')}Z`;
  // M p0, then Q p[i] mid(p[i], p[i+1]) (the native builders' path). No T: it overshoots on uneven spacing.
  let d = `M${f1(pts[0][0])},${f1(pts[0][1])}Q`;
  for (let i = 1; i < n; i++) { const p = pts[i], q = pts[(i + 1) % n]; d += `${f1(p[0])},${f1(p[1])} ${f1((p[0] + q[0]) / 2)},${f1((p[1] + q[1]) / 2)} `; }
  return d.trim() + 'Z';
}
function polyPath(pts, ext) {
  // centerline for the reveal mask, extended at both ends so round caps are uncovered too
  const n = pts.length;
  const e = (p, q) => { const dx = p[0] - q[0], dy = p[1] - q[1], l = Math.hypot(dx, dy) || 1; return [p[0] + (dx / l) * ext, p[1] + (dy / l) * ext]; };
  const s = n > 2 ? e(pts[0], pts[Math.min(2, n - 1)]) : pts[0];
  const t = n > 2 ? e(pts[n - 1], pts[Math.max(0, n - 3)]) : pts[n - 1];
  const all = [s, ...pts.filter((_, i) => i % 2 === 0 || i === n - 1), t];
  return 'M' + all.map(([x, y]) => `${f1(x)},${f1(y)}`).join('L');
}

/** One pen stroke (page-space points) → outline + centerline + length. */
export function penStroke(pts, { size, style = 'fountain', rand = Math.random, pressure = true, amp = 1 }) {
  const st = STYLES[style];
  let inp = pressure ? withPressure(pts, rand, amp) : pts.map((p) => [p[0], p[1], 0.5]);
  if (st.curve !== 1) inp = inp.map(([x, y, p]) => [x, y, Math.pow(p, st.curve)]);
  const sm = stabilize(inp, 0.3, 2);
  const out = getStroke(sm, { size, thinning: st.thinning, smoothing: 0.5, streamline: 0.45, simulatePressure: false, last: true });
  let len = 0; for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return { d: outlinePath(out), c: polyPath(pts, size * 0.9), len, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] };
}
export function highlighterStroke(pts, size) {
  const out = getStroke(pts.map((q) => [q[0], q[1], 0.5]), { size, thinning: 0, smoothing: 0.5, streamline: 0.5, simulatePressure: false, last: true });
  let len = 0; for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return { d: outlinePath(out), c: polyPath(pts, size * 0.6), len, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] };
}
export function freePath(d, step = 0.5) { return sample(d, step); }

// ---------- layout ----------
const SLANT = Math.tan((9 * Math.PI) / 180);
/**
 * Lays out items at (x, baseline y) with em scale s. Items: glyph chars (string), {frac:[num, den]}, {sup:[...]}, {gap:n}.
 * Returns { strokes: [{pts, kind:'pen'|'bar', glyph}], x }.
 */
export function layout(items, x0, y0, s, rand, opt = {}) {
  const strokes = [];
  let x = x0;
  const put = (ch, x, y, sc) => {
    const g = G[ch]; if (!g) throw new Error('no glyph ' + ch);
    const rot = (rand() - 0.5) * 0.05, ds = 1 + (rand() - 0.5) * 0.06, dy = (rand() - 0.5) * 2.2;
    for (const d of g.s) {
      const pts = sample(d, Math.min(2.4, 0.85 / sc)).map(([gx, gy]) => {
        const sx = gx * ds, sy = gy * ds;
        const rx = sx * Math.cos(rot) - sy * Math.sin(rot), ry = sx * Math.sin(rot) + sy * Math.cos(rot);
        return [x + (rx - ry * SLANT) * sc, y + (ry + dy) * sc];
      });
      strokes.push({ pts, glyph: ch });
    }
    return (g.a + (rand() - 0.5) * 4) * sc;
  };
  const measure = (its, sc) => its.reduce((w, it) => w + (typeof it === 'string' ? G[it].a * sc : it.sup ? 6 * sc + measure(it.sup, sc * 0.5) : it.gap ? it.gap * sc : 0), 0);
  const run = (its, sc, y) => {
    for (const it of its) {
      if (typeof it === 'string') { strokes.push({ pause: it === ' ' ? 'word' : 'glyph' }); x += put(it, x, y, sc); }
      else if (it.gap) x += it.gap * sc;
      else if (it.sup) { x += 5 * sc; run(it.sup, sc * 0.5, y - 50 * sc); x += 3 * sc; }
      else if (it.frac) {
        const fs = sc * 0.8;
        const [num, den] = it.frac;
        const wn = measure(num, fs), wd = measure(den, fs), w = Math.max(wn, wd) + 12 * sc;
        const axis = y - 22 * sc, startX = x + 4 * sc;
        const save = x;
        x = startX + (w - wn) / 2; run(num, fs, axis - 21 * sc);
        // bar, drawn after the numerator like a person would
        strokes.push({ pause: 'glyph' });
        const bar = sample(`M${startX},${axis + 1} C${startX + w * 0.35},${axis - 1} ${startX + w * 0.7},${axis - 0.5} ${startX + w},${axis - 1.5}`, 0.6);
        strokes.push({ pts: bar, glyph: 'bar' });
        x = startX + (w - wd) / 2; run(den, fs, axis + 14 * sc + 92 * fs);
        x = save + w + 18 * sc;
      }
    }
  };
  run(items, s, y0);
  return { strokes, x };
}
