import fs from 'node:fs';
import { hero, animatedSvgInner, staticSvgInner, penStyles, regionCrop } from './pieces.mjs';
import { layout, penStroke, highlighterStroke, freePath, rng } from './ink.mjs';

// Usage: node build.mjs [out.html]   (default: ../landing.html)
const OUT = process.argv[2] ?? new URL('../landing.html', import.meta.url);
let html = fs.readFileSync(new URL('./template.html', import.meta.url), 'utf8');
const set = (k, v) => { if (!html.includes(`{{${k}}}`)) throw new Error('missing ' + k); html = html.replaceAll(`{{${k}}}`, String(v)); };
const f1 = (n) => Math.round(n * 10) / 10;
const paths = (arr, fill) => arr.map((d) => `<path d="${d}"${fill ? ` fill="${fill}"` : ''}/>`).join('');

// ---- hero ----
const h = hero();
const l4 = h.strokes.filter((s) => s.group === 'l4');
const bx = [Math.min(...l4.map((s) => s.box[0])), Math.min(...l4.map((s) => s.box[1])), Math.max(...l4.map((s) => s.box[2])), Math.max(...l4.map((s) => s.box[3]))];
const AX = bx[0] - 10, AY = bx[1] - 9, AW = bx[2] - bx[0] + 20, AH = bx[3] - bx[1] + 18;
set('AX', f1(AX)); set('AY', f1(AY)); set('AW', f1(AW)); set('AH', f1(AH));
set('PX', f1(AX + AW + 16)); set('PY', f1(AY + AH / 2));
set('CARD_TOP', f1(((AY + AH / 2) / 440) * 100 - 9));
set('END', h.end.toFixed(2));
set('HERO_INK', animatedSvgInner(h).replace('<g class="hl">', '<g class="hl-ink">').replace('<g class="pen">', '<g class="pen-ink">'));
// (the sync devices reuse the hero ink with <use>, so there is no static copy)
// set('STATIC_INK', staticSvgInner(h).replace('<g class="hl">', '<g class="hl-ink">').replace('<g class="pen">', '<g fill="#27272a">'));

// ---- palm / contact page ----
{
  const r = rng(21);
  const a = layout(['y', ' ', '=', ' ', 'x', { sup: ['2'] }, ' ', '-', ' ', '4', 'x', ' ', '+', ' ', '4'], 60, 96, 0.36, r);
  const b = layout(['x', ' ', '=', ' ', '2'], 64, 176, 0.36, r);
  const all = [...a.strokes, ...b.strokes].filter((s) => s.pts).map((s) => penStroke(s.pts, { size: 3.1, rand: r }));
  const lastStroke = b.strokes.filter((s) => s.pts).at(-1).pts;
  const tip = lastStroke.at(-1);
  set('CONTACT_INK', `<g fill="#27272a">${paths(all.map((s) => s.d))}</g>`);
  set('TIPX', f1(tip[0] + 3)); set('TIPY', f1(tip[1]));
  set('TIPLX', f1(tip[0] + 18)); set('TIPLY', f1(tip[1] + 30)); set('TIPLY2', f1(tip[1] + 47));
}

// ---- nibs ----
const NIB_TEXT = {
  fountain: ['Fountain', 'Heavier on slow turns and downstrokes, lighter as you flick away.'],
  ball: ['Ball', 'An even, steady line, like a good ballpoint.'],
  brush: ['Brush', 'Swells with pressure. Good for headings and sketches.'],
};
set('NIBS', penStyles().map((p) => `<div class="card nib"><div class="sample"><svg viewBox="0 0 ${f1(p.w)} 92" aria-hidden="true">${paths(p.paths)}</svg></div><div><h3>${NIB_TEXT[p.style][0]}</h3><p>${NIB_TEXT[p.style][1]}</p></div></div>`).join('\n        '));

// ---- region crop ----
{
  const rc = regionCrop();
  const W = Math.ceil(rc.w);
  set('CROP_W', W);
  set('CROP_GREY', paths(rc.grey)); set('CROP_BLACK', paths(rc.black));
  const xs = rc.blackBox; // [x0, x1]
  set('NEWX', f1(xs[0] - 8)); set('NEWW', f1(xs[1] - xs[0] + 16));
  set('CROP_W3', W + 40); set('ANCW', f1(xs[1] + 6)); set('PIN2X', f1(xs[1] + 26));
}

// ---- PDF page ----
{
  const r = rng(5);
  // grey bars for typeset text: two paragraphs in a column, the right margin left for notes
  const bars = [];
  let y = 108;
  const para = (n, last) => { for (let i = 0; i < n; i++) { const w = i === n - 1 ? last : 248 + Math.round(r() * 22); bars.push([36, y, w]); y += 17; } y += 12; };
  para(5, 150); para(6, 190); para(4, 120);
  set('PDF_LINES', bars.map(([x, y, w]) => `<rect x="${x}" y="${y}" width="${w}" height="6" rx="3"/>`).join('') + `<rect x="122" y="${bars[8][1]}" width="52" height="6" rx="3" fill="#8b8b95"/>`);
  const RED = '#b91c1c';
  const hl = highlighterStroke(freePath(`M38,${bars[2][1] + 3} C110,${bars[2][1] + 4} 200,${bars[2][1] + 2} ${36 + bars[2][2] + 2},${bars[2][1] + 3}`, 1), 14).d;
  const wy = bars[8][1] + 3; // the looped word
  const loop = penStroke(freePath(`M114,${wy - 2} C116,${wy - 14} 154,${wy - 15} 176,${wy - 11} C194,${wy - 8} 196,${wy + 6} 182,${wy + 11} C160,${wy + 17} 122,${wy + 16} 114,${wy + 8} C108,${wy + 2} 114,${wy - 8} 126,${wy - 12}`, 0.6), { size: 2.3, rand: r }).d;
  const ax0 = 196, ay0 = wy - 4, ax1 = 318, ay1 = wy - 40;
  const arrow = [
    penStroke(freePath(`M${ax0},${ay0} C${ax0 + 40},${ay0 - 4} ${ax1 - 50},${ay1 + 10} ${ax1},${ay1}`, 0.6), { size: 2.2, rand: r }).d,
    penStroke(freePath(`M${ax1 - 13},${ay1 - 4} C${ax1 - 8},${ay1 - 2} ${ax1 - 3},${ay1 - 1} ${ax1},${ay1} C${ax1 - 4},${ay1 + 4} ${ax1 - 6},${ay1 + 8} ${ax1 - 8},${ay1 + 12}`, 0.6), { size: 2.2, rand: r }).d,
  ];
  const why = layout(['w', 'h', 'y', '?'], 326, ay1 + 6, 0.32, r).strokes.filter((s) => s.pts).map((s) => penStroke(s.pts, { size: 2.6, rand: r }).d);
  const tick = penStroke(layout(['✓'], 318, bars[13][1] + 8, 0.36, r).strokes.find((s) => s.pts).pts, { size: 2.8, rand: r }).d;
  // a snapped shape: a clean box around the heading (hold to snap)
  const box = `<rect x="27" y="65" width="184" height="28" rx="3" fill="none" stroke="#b91c1c" stroke-width="2" stroke-linejoin="round"/>`;
  set('PDF_INK', `<g class="hl-ink"><path d="${hl}"/></g>${box}<g fill="${RED}">${paths([loop, ...arrow, ...why])}</g><g fill="#0f766e"><path d="${tick}"/></g>`);
}

// ---- paper types ----
{
  const P = (kind) => {
    const g = [];
    if (kind === 'Ruled') for (let y = 22; y < 100; y += 9) g.push(`<path d="M6 ${y}h60" stroke="#d9dce3"/>`);
    if (kind === 'Dotted') for (let y = 10; y < 100; y += 8) for (let x = 8; x < 72; x += 8) g.push(`<circle cx="${x}" cy="${y}" r=".9" fill="#c5c9d2"/>`);
    if (kind === 'Grid') { for (let y = 8; y < 96; y += 8) g.push(`<path d="M0 ${y}h72" stroke="#e1e4ea"/>`); for (let x = 8; x < 72; x += 8) g.push(`<path d="M${x} 0v96" stroke="#e1e4ea"/>`); }
    if (kind === 'Cornell') { g.push('<path d="M20 12v62M0 74h72M0 12h72" stroke="#d9dce3"/>'); for (let y = 21; y < 74; y += 9) g.push(`<path d="M24 ${y}h44" stroke="#eceef2"/>`); }
    if (kind === 'Weekly') { g.push('<path d="M0 32h72M0 56h72M0 80h72M36 8v88" stroke="#d9dce3"/>'); }
    return `<figure><svg viewBox="0 0 72 96" aria-hidden="true"><rect width="72" height="96" fill="#fff"/><g stroke-width="1" fill="none">${g.join('')}</g></svg><figcaption>${kind}</figcaption></figure>`;
  };
  set('PAPERS', ['Blank', 'Ruled', 'Dotted', 'Grid', 'Cornell', 'Weekly'].map(P).join(''));
}

// ---- features ----
const ic = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const FEATS = [
  ['PDF import', 'Bring in slides, papers or worksheets and annotate every page.', '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>'],
  ['Images', 'Drop in a photo or a diagram and write around it.', '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>'],
  ['Text boxes', 'Type when typing is quicker. Maths symbols included.', '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>'],
  ['Shapes that snap', 'Draw a shape and hold. It snaps into a clean one.', '<path d="M4 18 12 5l8 13z"/><path d="M4 18h16" stroke-dasharray="2 3"/>'],
  ['Lasso and tap', 'Circle ink to move, resize, recolour or copy it, or just tap a stroke.', '<path d="M7 17c-3-2-4-6-1-9s10-4 13-1 1 8-4 9c-3 1-6 0-7-1"/><path d="M7 17c0 2-1 3-3 4"/>'],
  ['Page navigator', 'Thumbnails to jump, reorder, duplicate and bookmark pages.', '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="9" rx="1"/><rect x="3" y="15" width="7" height="6" rx="1"/><rect x="14" y="15" width="7" height="6" rx="1"/>'],
];
set('FEATURES', FEATS.map(([t, p, d]) => `<div>${ic(d)}<h3>${t}</h3><p>${p}</p></div>`).join('\n        '));

// ---- icons ----
set('I_WINDOWS', ic('<rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>'));
set('I_ANDROID', ic('<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M11 16h2"/>'));
set('I_IPAD', ic('<rect x="5" y="2.5" width="14" height="19" rx="2.5"/><path d="M11 18.5h2"/>'));
set('I_MAC', ic('<rect x="4" y="4" width="16" height="11" rx="1.5"/><path d="M2 19h20l-1.5-4h-17z"/>'));
set('I_WEB', ic('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 3 3.5 6 3.5 9s-1 6-3.5 9c-2.5-3-3.5-6-3.5-9s1-6 3.5-9z"/>'));
set('I_DOWNLOAD', ic('<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>'));
set('I_CHECK', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>');
set('I_CROSS', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>');

// ---- underline swoosh (brush nib, indigo) ----
{
  const r = rng(3);
  const pts = freePath('M4,12 C60,8 150,7 220,8 C250,8.5 280,10 296,12', 0.8);
  set('UL_W', 300);
  set('UNDERLINE', `<path d="${penStroke(pts, { size: 7, style: 'brush', rand: r }).d}"/>`);
}

// ---- mark (ids must be unique per use) ----
let markN = 0;
const markSvg = fs.readFileSync(new URL('../../assets/brand/qalm-mark.svg', import.meta.url), 'utf8');
html = html.replace(/\{\{MARK\}\}/g, () => {
  const id = `qalm-ring-${++markN}`;
  return markSvg
    .replace(/<!--.*?-->\s*/s, '')
    .replace('<svg ', '<svg class="mark" aria-hidden="true" focusable="false" ')
    .replace(' xmlns="http://www.w3.org/2000/svg"', '')
    .replaceAll('qalm-ring', id)
    .replace(/stroke="#4338CA"/g, 'class="orbit"')
    .replace(/stroke="#27272A"/g, 'class="nib"')
    .replace(/fill="#27272A"/g, 'class="nibfill"')
    .replace(/fill="#1D4ED8"/g, 'class="planet"')
    .replace(/\n\s*/g, '');
});
set('FAVICON', 'data:image/svg+xml,' + encodeURIComponent(markSvg.replace(/<!--.*?-->\s*/s, '').replace(/\n\s*/g, '')));

fs.writeFileSync(OUT, html);
console.log('wrote', OUT, (html.length / 1024).toFixed(1) + ' KB', 'end', h.end.toFixed(2));
