// Assets made from scratch for the demo notebooks, so their licensing is clean: a lecture slide deck (HTML printed to
// PDF by headless Chrome, maths typeset by MathJax) and an animal cell diagram (SVG rasterised by sharp).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);

function mathjax(root) {
  const req = createRequire(join(root, 'package.json'));
  const { mathjax } = req('mathjax-full/js/mathjax.js');
  const { TeX } = req('mathjax-full/js/input/tex.js');
  req('mathjax-full/js/input/tex/base/BaseConfiguration.js');
  req('mathjax-full/js/input/tex/ams/AmsConfiguration.js');
  const { SVG } = req('mathjax-full/js/output/svg.js');
  const { liteAdaptor } = req('mathjax-full/js/adaptors/liteAdaptor.js');
  const { RegisterHTMLHandler } = req('mathjax-full/js/handlers/html.js');
  const adaptor = liteAdaptor();
  RegisterHTMLHandler(adaptor);
  const doc = mathjax.document('', { InputJax: new TeX({ packages: ['base', 'ams'] }), OutputJax: new SVG({ fontCache: 'none' }) });
  return (tex, display = false) => adaptor.innerHTML(doc.convert(tex, { display }));
}

const font = (w, file) => {
  const b = readFileSync(require.resolve(`@expo-google-fonts/figtree/${file}/Figtree_${file}.ttf`)).toString('base64');
  return `@font-face{font-family:Figtree;font-weight:${w};src:url(data:font/ttf;base64,${b})}`;
};

/** Slide size in PDF points: 16:9. */
export const SLIDE = { w: 768, h: 432 };

/** The lecture deck: MATH 201 · Calculus II, lecture 7, integration by parts. Returns PDF bytes. */
export function deckHtml(root) {
  const m = mathjax(root);
  const M = (t) => `<span class="m">${m(t)}</span>`;
  const D = (t) => `<div class="d">${m(t, true)}</div>`;
  const foot = (n) => `<footer><span>MATH 201 · Calculus II</span><span>Lecture 7 · Integration by parts</span><span>${n}</span></footer>`;
  const slides = [
    `<section class="title"><div class="kicker">MATH 201 · Calculus II · Lecture 7</div><h1>Integration by parts</h1>
      <p class="sub">Undoing the product rule</p><div class="who">Dr. Amara Okafor · Hall B · Tuesday 18 November 2026</div>
      <div class="band"></div></section>`,
    `<section><h2>The product rule, backwards</h2>
      <p>Start from the product rule for two differentiable functions ${M('u(x)')} and ${M('v(x)')}:</p>
      ${D("\\frac{d}{dx}\\big[\\,u\\,v\\,\\big] = u'\\,v + u\\,v'")}
      <p>Integrate both sides and rearrange:</p>
      ${D('\\int u\\,dv \\;=\\; u\\,v \\;-\\; \\int v\\,du')}
      <p class="note">Trade an integral you can’t do for one you can.</p>${foot(2)}</section>`,
    `<section><h2>Choosing ${M('u')}: LIATE</h2>
      <div class="cols"><ol class="liate"><li><i><b>L</b>ogarithmic </i><span>${M('\\ln x')}</span></li><li><i><b>I</b>nverse trig </i><span>${M('\\arctan x')}</span></li><li><i><b>A</b>lgebraic </i><span>${M('x^2,\\ 3x')}</span></li><li><i><b>T</b>rigonometric </i><span>${M('\\sin x')}</span></li><li><i><b>E</b>xponential </i><span>${M('e^{x}')}</span></li></ol>
      <div class="aside"><p>Pick ${M('u')} from the <em>earliest</em> type in the list; the rest is ${M('dv')}.</p><p>${M('du')} should be simpler than ${M('u')}, and ${M('dv')} easy to integrate.</p></div></div>${foot(3)}</section>`,
    `<section><h2>Example 1</h2>
      ${D('\\int x\\,e^{x}\\,dx')}
      <div class="grid2"><div>${M('u = x')}</div><div>${M('dv = e^{x}\\,dx')}</div><div>${M('du = \\ ?')}</div><div>${M('v = \\ ?')}</div></div>
      <p class="note">Fill in the table, then apply the formula.</p>${foot(4)}</section>`,
    `<section><h2>Try these</h2>
      <ol class="try"><li>${M('\\displaystyle\\int \\ln x\\,dx')}</li><li>${M('\\displaystyle\\int x^{2}\\sin x\\,dx')}</li><li>${M('\\displaystyle\\int_{0}^{1} x\\,e^{2x}\\,dx')}</li><li>${M('\\displaystyle\\int e^{x}\\cos x\\,dx')}</li></ol>
      <p class="note">Hint for 4: integrate by parts twice and solve for the integral.</p>${foot(5)}</section>`,
  ];
  const css = `${font(400, '400Regular')}${font(500, '500Medium')}${font(600, '600SemiBold')}${font(700, '700Bold')}
  @page{size:${SLIDE.w}pt ${SLIDE.h}pt;margin:0}
  *{box-sizing:border-box;margin:0}
  body{font-family:Figtree;color:#1f2430}
  section{width:${SLIDE.w}pt;height:${SLIDE.h}pt;padding:34pt 44pt;position:relative;page-break-after:always;overflow:hidden;background:#fff}
  h2{font-size:24pt;font-weight:700;letter-spacing:-.02em;color:#1e293b;margin-bottom:14pt;padding-bottom:9pt;border-bottom:2pt solid #0f766e;display:inline-block}
  p{font-size:13.5pt;line-height:1.45;color:#334155;max-width:440pt;margin:6pt 0}
  .note{color:#0f766e;font-weight:600;margin-top:10pt}
  .d{margin:6pt 0 4pt 18pt;font-size:15pt;color:#0f172a}
  .m svg{vertical-align:middle}
  footer{position:absolute;left:44pt;right:44pt;bottom:16pt;display:flex;justify-content:space-between;font-size:8pt;color:#94a3b8}
  .title{background:#0f3d3a;color:#fff;padding:60pt 54pt}
  .title .kicker{font-size:11pt;color:#99f6e4;font-weight:600;letter-spacing:.02em}
  .title h1{font-size:44pt;font-weight:700;letter-spacing:-.03em;margin:14pt 0 8pt}
  .title .sub{font-size:17pt;color:#ccfbf1;max-width:none}
  .title .who{position:absolute;left:54pt;bottom:46pt;font-size:10.5pt;color:#a7c4c0}
  .title .band{position:absolute;right:-60pt;top:-40pt;width:300pt;height:520pt;background:#134e4a;transform:rotate(18deg)}
  .cols{display:flex;gap:30pt;align-items:flex-start}
  .liate{list-style:none;padding:0;width:270pt}
  .liate li{font-size:15pt;padding:7pt 10pt;border-bottom:1pt solid #e2e8f0;display:flex;justify-content:space-between;color:#334155}
  .liate i{font-style:normal}.liate b{color:#0f766e;font-size:17pt}
  .liate span{color:#64748b}
  .aside{background:#f0fdfa;border:1pt solid #99f6e4;border-radius:8pt;padding:10pt 14pt;width:220pt;margin-top:4pt}
  .aside p{font-size:11.5pt}
  .grid2{display:grid;grid-template-columns:150pt 170pt;gap:12pt 26pt;margin:14pt 0 0 24pt;font-size:15pt}
  .try{font-size:16pt;line-height:2.15;color:#1e293b;padding-left:26pt}`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${slides.join('')}</body></html>`;
}

export async function lectureDeck(browser, root) {
  const html = deckHtml(root);
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'load' });
  const pdf = await page.pdf({ width: `${(SLIDE.w * 4) / 3}px`, height: `${(SLIDE.h * 4) / 3}px`, printBackground: true, preferCSSPageSize: true });
  await page.close();
  return new Uint8Array(pdf);
}

/** An animal cell, drawn for this demo: flat fills in a soft palette, no labels (the student labels it in ink). */
export function cellSvg() {
  const W = 900, H = 640;
  const blob = (cx, cy, r, n, amp, seed) => {
    let s = seed;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const rr = r * (1 + (rnd() - 0.5) * amp);
      pts.push([cx + Math.cos(a) * rr * 1.18, cy + Math.sin(a) * rr * 0.86]);
    }
    let d = '';
    for (let i = 0; i < n; i++) {
      const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
      if (!i) d += `M${p1[0].toFixed(1)},${p1[1].toFixed(1)}`;
      d += ` C${(p1[0] + (p2[0] - p0[0]) / 6).toFixed(1)},${(p1[1] + (p2[1] - p0[1]) / 6).toFixed(1)} ${(p2[0] - (p3[0] - p1[0]) / 6).toFixed(1)},${(p2[1] - (p3[1] - p1[1]) / 6).toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
    }
    return d + 'Z';
  };
  const mito = (x, y, rot, s = 1) => `<g transform="translate(${x},${y}) rotate(${rot}) scale(${s})">
    <ellipse rx="46" ry="21" fill="#f6b48f" stroke="#c96a43" stroke-width="3"/>
    <path d="M-34,0 q6,-14 12,0 t12,0 t12,0 t12,0 t12,0" fill="none" stroke="#c96a43" stroke-width="2.6" stroke-linecap="round"/></g>`;
  const ribo = [];
  let s = 7;
  const rnd = () => ((s = (s * 48271) % 2147483647) / 2147483647);
  for (let i = 0; i < 70; i++) {
    const a = rnd() * Math.PI * 2, r = 120 + rnd() * 170;
    const x = 450 + Math.cos(a) * r * 1.15, y = 320 + Math.sin(a) * r * 0.8;
    if (Math.hypot((x - 430) / 130, (y - 300) / 100) < 1.15) continue;
    ribo.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.2" fill="#6d5bd0"/>`);
  }
  const er = [0, 1, 2, 3].map((k) => `<path d="M${560 + k * 14},${210 + k * 6} C${640 + k * 10},${180 + k * 8} ${690 + k * 8},${250 + k * 10} ${650 + k * 6},${300 + k * 12} S${590 + k * 8},${360 + k * 10} ${640 + k * 4},${410 + k * 8}" fill="none" stroke="#8fb8e8" stroke-width="9" stroke-linecap="round"/>`).join('');
  const golgi = [0, 1, 2, 3].map((k) => `<path d="M${240 - k * 4},${430 + k * 15} q${50},-${28 - k * 3} ${100 + k * 6},0" fill="none" stroke="#e6a7c4" stroke-width="10" stroke-linecap="round"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <path d="${blob(450, 320, 330, 14, 0.12, 11)}" fill="#fdf3dc" stroke="#d9a441" stroke-width="7"/>
  <path d="${blob(450, 320, 318, 14, 0.12, 11)}" fill="none" stroke="#f3d898" stroke-width="3" opacity=".8"/>
  ${er}
  ${golgi}
  <ellipse cx="430" cy="300" rx="128" ry="98" fill="#d9d2fb" stroke="#7c6be0" stroke-width="5"/>
  <ellipse cx="430" cy="300" rx="112" ry="84" fill="none" stroke="#b8acf5" stroke-width="2" stroke-dasharray="7 7"/>
  <ellipse cx="452" cy="288" rx="38" ry="30" fill="#7c6be0"/>
  ${ribo.join('')}
  ${mito(220, 260, -28)}${mito(690, 470, 18, 0.9)}${mito(330, 520, 8, 0.85)}${mito(250, 140, 30, 0.8)}
  <circle cx="610" cy="140" r="22" fill="#c7ead6" stroke="#4fa477" stroke-width="3"/>
  <circle cx="700" cy="380" r="15" fill="#c7ead6" stroke="#4fa477" stroke-width="3"/>
  <circle cx="160" cy="400" r="18" fill="#c7ead6" stroke="#4fa477" stroke-width="3"/>
  <g fill="#e4c46c"><circle cx="540" cy="460" r="7"/><circle cx="556" cy="472" r="7"/></g>
</svg>`;
}

export async function cellPng() {
  const sharp = require('sharp');
  return new Uint8Array(await sharp(Buffer.from(cellSvg()), { density: 144 }).png({ compressionLevel: 9 }).toBuffer());
}
