// The landing page: template.html filled with generated ink, icons and the shared partials.
import fs from 'node:fs';
import { hero, animatedSvgInner, penStyles, regionCrop } from './pieces.mjs';
import { layout, penStroke, highlighterStroke, freePath, rng } from './ink.mjs';
import { BUILD_NOTE, ICONS, SHARED_CSS, fill, footer, head, header, icon } from './site.mjs';

const f1 = (n) => Math.round(n * 10) / 10;
const paths = (arr, color) => arr.map((d) => `<path d="${d}"${color ? ` fill="${color}"` : ''}/>`).join('');

/** The hand-drawn indigo underline (brush nib), shared with the other pages. */
export function underline() {
  const r = rng(3);
  const pts = freePath('M4,12 C60,8 150,7 220,8 C250,8.5 280,10 296,12', 0.8);
  return `<svg viewBox="0 0 300 24" preserveAspectRatio="none" aria-hidden="true"><path d="${penStroke(pts, { size: 7, style: 'brush', rand: r }).d}"/></svg>`;
}

export function renderLanding() {
  const v = {};

  // ---- hero ----
  const h = hero();
  v.END = h.end.toFixed(2);
  v.HERO_INK = animatedSvgInner(h).replace('<g class="hl">', '<g class="hl-ink">').replace('<g class="pen">', '<g class="pen-ink">');

  // ---- palm / contact page ----
  {
    const r = rng(21);
    const a = layout(['y', ' ', '=', ' ', 'x', { sup: ['2'] }, ' ', '-', ' ', '4', 'x', ' ', '+', ' ', '4'], 60, 96, 0.36, r);
    const b = layout(['x', ' ', '=', ' ', '2'], 64, 176, 0.36, r);
    const all = [...a.strokes, ...b.strokes].filter((s) => s.pts).map((s) => penStroke(s.pts, { size: 3.1, rand: r }));
    const tip = b.strokes.filter((s) => s.pts).at(-1).pts.at(-1);
    v.CONTACT_INK = `<g fill="#27272a">${paths(all.map((s) => s.d))}</g>`;
    Object.assign(v, { TIPX: f1(tip[0] + 3), TIPY: f1(tip[1]), TIPLX: f1(tip[0] + 18), TIPLY: f1(tip[1] + 30), TIPLY2: f1(tip[1] + 47) });
  }

  // ---- nibs ----
  const NIB_TEXT = {
    fountain: ['Fountain', 'Thick and thin, like a real nib.'],
    ball: ['Ball', 'Even and steady.'],
    brush: ['Brush', 'Swells with pressure.'],
  };
  v.NIBS = penStyles()
    .map((p) => `<div class="card nib"><div class="sample"><svg viewBox="0 0 ${f1(p.w)} 92" aria-hidden="true">${paths(p.paths)}</svg></div><div><h3>${NIB_TEXT[p.style][0]}</h3><p>${NIB_TEXT[p.style][1]}</p></div></div>`)
    .join('\n        ');

  // ---- region crop ----
  {
    const rc = regionCrop();
    v.CROP_W = Math.ceil(rc.w);
    v.CROP_GREY = paths(rc.grey);
    v.CROP_BLACK = paths(rc.black);
  }

  // ---- PDF page ----
  {
    const r = rng(5);
    // grey bars for typeset text: two paragraphs in a column, the right margin left for notes
    const bars = [];
    let y = 108;
    const para = (n, last) => {
      for (let i = 0; i < n; i++) {
        const w = i === n - 1 ? last : 248 + Math.round(r() * 22);
        bars.push([36, y, w]);
        y += 17;
      }
      y += 12;
    };
    para(5, 150);
    para(6, 190);
    para(4, 120);
    v.PDF_LINES = bars.map(([x, y, w]) => `<rect x="${x}" y="${y}" width="${w}" height="6" rx="3"/>`).join('') + `<rect x="122" y="${bars[8][1]}" width="52" height="6" rx="3" fill="#8b8b95"/>`;
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
    v.PDF_INK = `<g class="hl-ink"><path d="${hl}"/></g>${box}<g fill="${RED}">${paths([loop, ...arrow, ...why])}</g><g fill="#0f766e"><path d="${tick}"/></g>`;
  }

  // ---- paper types ----
  {
    const P = (kind) => {
      const g = [];
      if (kind === 'Ruled') for (let y = 22; y < 100; y += 9) g.push(`<path d="M6 ${y}h60" stroke="#d9dce3"/>`);
      if (kind === 'Dotted') for (let y = 10; y < 100; y += 8) for (let x = 8; x < 72; x += 8) g.push(`<circle cx="${x}" cy="${y}" r=".9" fill="#c5c9d2"/>`);
      if (kind === 'Grid') {
        for (let y = 8; y < 96; y += 8) g.push(`<path d="M0 ${y}h72" stroke="#e1e4ea"/>`);
        for (let x = 8; x < 72; x += 8) g.push(`<path d="M${x} 0v96" stroke="#e1e4ea"/>`);
      }
      if (kind === 'Cornell') {
        g.push('<path d="M20 12v62M0 74h72M0 12h72" stroke="#d9dce3"/>');
        for (let y = 21; y < 74; y += 9) g.push(`<path d="M24 ${y}h44" stroke="#eceef2"/>`);
      }
      if (kind === 'Weekly') g.push('<path d="M0 32h72M0 56h72M0 80h72M36 8v88" stroke="#d9dce3"/>');
      return `<figure><svg viewBox="0 0 72 96" aria-hidden="true"><rect width="72" height="96" fill="#fff"/><g stroke-width="1" fill="none">${g.join('')}</g></svg><figcaption>${kind}</figcaption></figure>`;
    };
    v.PAPERS = ['Blank', 'Ruled', 'Dotted', 'Grid', 'Cornell', 'Weekly'].map(P).join('');
  }

  // ---- screenshots of the real app (apps/site/showcase → public/showcase; manifest.json has their sizes) ----
  {
    const manifest = JSON.parse(fs.readFileSync(new URL('../public/showcase/manifest.json', import.meta.url), 'utf8'));
    /** A light/dark pair as one <picture> (AVIF, then WebP), following the visitor's colour scheme. */
    const shot = (key, alt, sizes, { eager = false, cls = '' } = {}) => {
      const m = manifest[key];
      if (!m) throw new Error(`No showcase image ${key}: run apps/site/showcase/frame.mjs`);
      const set = (theme, ext) => m.widths.map((w) => `/showcase/${m.path}-${theme}-${w}.${ext} ${w}w`).join(', ');
      const dark = '(prefers-color-scheme: dark)';
      return (
        `<picture class="shot${cls ? ` ${cls}` : ''}">` +
        `<source type="image/avif" media="${dark}" srcset="${set('dark', 'avif')}" sizes="${sizes}">` +
        `<source type="image/webp" media="${dark}" srcset="${set('dark', 'webp')}" sizes="${sizes}">` +
        `<source type="image/avif" srcset="${set('light', 'avif')}" sizes="${sizes}">` +
        `<img src="/showcase/${m.path}-light-${m.widths[0]}.webp" srcset="${set('light', 'webp')}" sizes="${sizes}" width="${m.w}" height="${m.h}" alt="${alt}" ${eager ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async"></picture>`
      );
    };
    const wide = '(max-width: 860px) 100vw, 1200px';
    const half = '(max-width: 860px) 100vw, 600px';
    v.SHOT_HERO = shot('hero', 'qalm on a laptop and a tablet: lecture slides annotated by hand, and a labelled diagram of an animal cell.', '(max-width: 1240px) 100vw, 1200px');
    v.SHOTS_PEN = [
      shot('colours-tablet', 'Choosing a pen colour on a tablet, over a hand-labelled cell diagram.', half),
      shot('ruler-tablet', 'The ruler turned to the refracted ray in a physics diagram, with the ray drawn straight along its edge.', half),
    ].join('');
    v.SHOTS_NB = [
      shot('library-desktop', 'The library: notebooks with coloured covers in folders, favourites and a notebook shared with AI.', half),
      shot('image-tablet', 'A diagram of an animal cell, labelled in handwriting with snapped arrows.', half),
    ].join('');
    v.SHOT_LECTURE = shot('lecture-desktop', 'Replaying a recorded lecture: the slide’s handwriting at 29:17, the player bar and the transcript following along.', wide);
    v.SHOTS_TOOLS = [
      shot('present-desktop', 'Presenting the slides with the laser pointer.', half),
      shot('markdown-tablet', 'A text box with Markdown and maths next to handwritten working on a slide.', half),
      shot('lasso-tablet', 'Lasso selection with handles over a list of French verbs.', half),
      shot('navigator-tablet', 'The page navigator with slide thumbnails.', half),
    ].join('');
    v.SHOT_AI = shot('ai-desktop', 'AI live with a tutor: a comment thread beside the ink, with a reply that has maths in it.', wide);
  }

  // ---- features ----
  const FEATS = [
    ['PDF import', 'Slides, papers, worksheets. Write on every page.', '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>'],
    ['Images', 'Drop in a photo or a diagram. Write around it.', '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>'],
    ['Text boxes', 'For when typing is quicker. Maths symbols too.', '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>'],
    ['Shapes that snap', 'Draw a shape, hold, and it snaps clean.', '<path d="M4 18 12 5l8 13z"/><path d="M4 18h16" stroke-dasharray="2 3"/>'],
    ['Lasso and tap', 'Circle ink to move, resize or recolour it. Or just tap a stroke.', '<path d="M7 17c-3-2-4-6-1-9s10-4 13-1 1 8-4 9c-3 1-6 0-7-1"/><path d="M7 17c0 2-1 3-3 4"/>'],
    ['Page navigator', 'Thumbnails to jump, reorder and bookmark.', '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="9" rx="1"/><rect x="3" y="15" width="7" height="6" rx="1"/><rect x="14" y="15" width="7" height="6" rx="1"/>'],
  ];
  v.FEATURES = FEATS.map(([t, p, d]) => `<div>${icon(d)}<h3>${t}</h3><p>${p}</p></div>`).join('\n        ');

  // ---- icons, underline, partials ----
  Object.assign(v, {
    I_WINDOWS: ICONS.windows,
    I_ANDROID: ICONS.android,
    I_IPAD: ICONS.ipad,
    I_MAC: ICONS.mac,
    I_WEB: ICONS.web,
    I_DOWNLOAD: ICONS.download,
    I_CHECK: ICONS.check,
    I_CROSS: ICONS.cross,
    UL_W: 300,
    UNDERLINE: underline().replace(/^<svg[^>]*>|<\/svg>$/g, ''),
    BUILD_NOTE,
    SHARED_CSS,
    HEAD: head({
      title: 'qalm by Apollo: handwritten notes that keep up with you',
      ogTitle: "qalm: a handwriting app that doesn't suck",
      description: 'Ink that keeps up with your pen, palm rejection that actually works, and pages that feel like paper. For Windows, Android tablets and the web; iPad and Mac coming soon.',
      path: '/',
    }),
    HEADER: header({ landing: true }),
    FOOTER: footer(),
  });

  const template = fs.readFileSync(new URL('./template.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  return { html: fill(template, v), end: h.end };
}
