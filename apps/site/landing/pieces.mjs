import { layout, penStroke, highlighterStroke, freePath, rng } from './ink.mjs';

const PEN = '#27272a', INDIGO = '#4338ca';

/** Turns a layout into timed strokes. v = pen speed in page units per second. */
function timeline(blocks, { v = 300, t0 = 0.5 } = {}) {
  let t = t0;
  const out = [];
  for (const b of blocks) {
    t += b.before ?? 0;
    for (const s of b.strokes) {
      if (b.pre && s.pts) { const st = penStroke(s.pts, { size: b.size, rand: b.rand }); out.push({ ...st, color: b.color, pre: true, group: b.group }); continue; }
      if (b.pre) continue;
      if (s.pause) { t += s.pause === 'word' ? 0.08 : 0.018; continue; }
      const st = b.hl ? highlighterStroke(s.pts, b.size) : penStroke(s.pts, { size: b.size, rand: b.rand, style: b.style });
      const dur = Math.max(0.06, st.len / ((b.hl ? v * 1.8 : v) * (b.speed ?? 1)));
      out.push({ ...st, color: b.color, hl: !!b.hl, delay: t, dur, group: b.group });
      t += dur + 0.02;
    }
  }
  return { strokes: out, end: t };
}

// ---------- hero page: a page of notes on integration by parts ----------
// The heading and first line are already on the page; the working, a highlight and a reminder write themselves in.
export function hero() {
  const r = rng(7);
  const S = 0.34;
  const chars = (t) => t.split('');
  const title = layout(chars('Integration by parts'), 56, 84, 0.4, r);
  const rule = freePath(`M52,98 C140,95 230,96 ${title.x + 2},93`, 0.8);
  const l1 = layout(['∫', ' ', 'x', ' ', 'l', 'n', ' ', 'x', ' ', 'd', 'x'], 58, 166, S, r);
  const side = layout(['u', ' ', '=', ' ', 'l', 'n', ' ', 'x', ',', ' ', ' ', 'd', 'v', ' ', '=', ' ', 'x', ' ', 'd', 'x'], 304, 162, 0.25, r);
  const l3 = layout(['=', ' ', { frac: [['x', { sup: ['2'] }], ['2']] }, 'l', 'n', ' ', 'x', ' ', '-', ' ', '∫', ' ', { frac: [['x'], ['2']] }, 'd', 'x'], 62, 256, S, r);
  const l4 = layout(['=', ' ', { frac: [['x', { sup: ['2'] }], ['2']] }, 'l', 'n', ' ', 'x', ' ', '-', ' ', { frac: [['x', { sup: ['2'] }], ['4']] }, '+', ' ', 'C'], 62, 346, S, r);
  const hlPts = freePath(`M98,338 C190,341 300,336 ${l4.x + 4},339`, 1);
  const note = layout(chars('check: differentiate it!'), 64, 414, 0.27, r);
  const tl = timeline([
    { strokes: title.strokes, size: 3.4, color: PEN, rand: r, group: 'title', pre: true },
    { strokes: [{ pts: rule }], size: 2.6, color: INDIGO, rand: r, group: 'rule', pre: true },
    { strokes: l1.strokes, size: 3.1, color: PEN, rand: r, group: 'l1', pre: true },
    { strokes: side.strokes, size: 2.4, color: INDIGO, rand: r, group: 'side', pre: true },
    { strokes: l3.strokes, size: 3.1, color: PEN, rand: r, group: 'l3' },
    { strokes: l4.strokes, size: 3.1, color: PEN, rand: r, before: 0.3, group: 'l4' },
    { strokes: [{ pts: hlPts }], size: 30, hl: true, color: '#fde68a', before: 0.25, group: 'hl' },
    { strokes: note.strokes, size: 2.5, color: INDIGO, rand: r, before: 0.35, group: 'note', speed: 1.5 },
  ], { v: 720, t0: 0.8 });
  return { ...tl, l4end: l4.x };
}

/** SVG markup: highlights first (multiply, under the ink), then pen strokes, each revealed by its own mask. */
export function animatedSvgInner(tl, idp = 'h') {
  const defs = [], hl = [], ink = [];
  tl.strokes.forEach((s, i) => {
    if (s.pre) { ink.push(`<path d="${s.d}"${s.color !== '#27272a' ? ` fill="${s.color}"` : ''}/>`); return; }
    const pad = 20;
    const [x0, y0, x1, y1] = s.box;
    const sw = s.hl ? 34 : 9;
    defs.push(`<mask id="${idp}${i}" maskUnits="userSpaceOnUse" x="${Math.floor(x0 - pad)}" y="${Math.floor(y0 - pad)}" width="${Math.ceil(x1 - x0 + 2 * pad)}" height="${Math.ceil(y1 - y0 + 2 * pad)}"><path d="${s.c}" pathLength="1" stroke-width="${sw}" style="--d:${s.delay.toFixed(2)}s;--t:${s.dur.toFixed(2)}s"/></mask>`);
    const el = `<path d="${s.d}" mask="url(#${idp}${i})"${s.color !== '#27272a' ? ` fill="${s.color}"` : ''}/>`;
    (s.hl ? hl : ink).push(el);
  });
  return `<defs>${defs.join('')}</defs><g class="hl">${hl.join('')}</g><g class="pen">${ink.join('')}</g>`;
}
export function staticSvgInner(tl) {
  const hl = tl.strokes.filter((s) => s.hl).map((s) => `<path d="${s.d}"/>`).join('');
  const pen = tl.strokes.filter((s) => !s.hl).map((s) => `<path d="${s.d}"${s.color !== '#27272a' ? ` fill="${s.color}"` : ''}/>`).join('');
  return `<g class="hl">${hl}</g><g class="pen">${pen}</g>`;
}

// ---------- pen styles: "qalm" in each nib ----------
export function penStyles() {
  return ['fountain', 'ball', 'brush'].map((style, k) => {
    const r = rng(31 + k * 0);
    const l = layout(['q', 'a', 'l', 'm'], 10, 62, 0.5, r);
    const ps = l.strokes.filter((s) => s.pts).map((s) => penStroke(s.pts, { size: { fountain: 4.6, ball: 3.4, brush: 6 }[style], style, rand: r, amp: { fountain: 2.7, ball: 1, brush: 2.2 }[style] }).d);
    return { style, paths: ps, w: l.x + 14 };
  });
}

// ---------- the AI region crop: new ink black, context grey ----------
export function regionCrop() {
  const r = rng(7);
  const ctx = layout(['=', ' ', { frac: [['x', { sup: ['2'] }], ['2']] }, 'l', 'n', ' ', 'x'], 14, 70, 0.34, r);
  const nw = layout(['-', ' ', { frac: [['x', { sup: ['2'] }], ['4']] }, '+', ' ', 'C'], ctx.x + 8, 70, 0.34, r);
  const grey = ctx.strokes.filter((s) => s.pts).map((s) => penStroke(s.pts, { size: 3.1, rand: r }).d);
  const bs = nw.strokes.filter((s) => s.pts).map((s) => penStroke(s.pts, { size: 3.1, rand: r }));
  const black = bs.map((s) => s.d);
  const blackBox = [Math.min(...bs.map((s) => s.box[0])), Math.max(...bs.map((s) => s.box[2]))];
  return { grey, black, blackBox, w: nw.x + 10 };
}
