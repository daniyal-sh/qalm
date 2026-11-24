// The demo library: a top student's notebooks, built with @qalm/core's own model (the same docs the app writes), so the
// app renders them natively. Everything here is made up: names, the lecture, the slides, the diagram.
import { createHash } from 'node:crypto';
import { loadCore } from './core.mjs';
import { Hand, highlight, nextId, resetIds, rng } from './hand.mjs';
import { SLIDE } from './assets.mjs';

const C = { graphite: '#27272a', indigo: '#4338ca', blue: '#1d4ed8', teal: '#0f766e', red: '#b91c1c', amber: '#b45309' };
const HL = { yellow: '#fde68a', blue: '#bfdbfe', green: '#bbf7d0', pink: '#fbcfe8' };
const COVER = { graphite: '#27272a', indigo: '#4338ca', blue: '#1d4ed8', teal: '#0f766e', sand: '#d6c7a8', rose: '#c9a3a3', sage: '#a7b8a1', paper: '#f1efe9' };
const A4 = { w: 595, h: 842 };
const at = (d, h = 9, m = 0) => Date.UTC(2026, 10, d, h, m); // November 2026
export const STUDENT = { name: 'Maya Chen', email: 'maya.chen@example.com' };
export const TUTOR = 'Tutor';

/** Runs `fn` with Date.now() pinned (comments and replies take their time from it). */
function pinned(ms, fn) {
  const real = Date.now;
  Date.now = () => ms;
  try {
    return fn();
  } finally {
    Date.now = real;
  }
}

function uuid(r) {
  const h = Array.from({ length: 16 }, () => Math.floor(r() * 256).toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Shapes as the app stores a snapped shape. */
const shape = (kind, pts, color = C.graphite, width = 1.4) => ({ id: nextId('sh'), type: 'shape', kind, pts, color, width });
const rectPts = ([x0, y0, x1, y1]) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const textBox = (x, y, w, text, o = {}) => ({ id: nextId('tx'), type: 'text', x, y, w, text, fontSize: o.size ?? 13, color: o.color ?? C.graphite, format: 'md' });

/** `deckPdf` and `cellPng` are the bytes from assets.mjs. */
export async function buildLibrary({ deckPdf, cellPng }) {
  const core = await loadCore();
  const { Y, Notebook, Page, Library, LectureDoc, createNotebookDoc, summarizeThreads, packTimelineChunk, lectureDocId } = core;
  resetIds();
  const ids = rng(2026);
  const docs = []; // { docId, doc }
  const assets = []; // { sha, mime, bytes }
  const entries = []; // library entries
  const lectures = [];
  const out = { notebooks: {} };

  function addAsset(bytes, mime, name, extra = {}) {
    const sha = createHash('sha256').update(bytes).digest('hex');
    assets.push({ sha, mime, bytes });
    return { id: uuid(ids), sha256: sha, mime, name, bytes: bytes.length, ...extra };
  }

  /** A notebook: `pages` is a list of { info?: Partial<PageInfo>, build(page, info) } */
  function notebook({ key, title, cover, paper = 'ruled', paperColor = 'white', size = A4, pages, folder = null, favorite = false, aiAccess = false, created, updated, asset }) {
    const id = uuid(ids);
    const doc = createNotebookDoc({ id, title, cover, paper, paperColor, size });
    const nb = new Notebook(doc);
    const first = nb.pages().map((p) => p.id);
    if (asset) nb.addAsset(asset);
    const pageInfos = pages.map((p) => {
      const pid = uuid(ids);
      nb.addPage({ id: pid, ...(p.info ?? {}) });
      return pid;
    });
    for (const f of first) nb.removePage(f);
    const infos = nb.pages();
    const pageDocs = {};
    const threads = [];
    pages.forEach((p, i) => {
      const pdoc = new Y.Doc();
      const page = new Page(pdoc);
      p.build?.(page, infos[i], { nb, i });
      pageDocs[infos[i].id] = page;
      docs.push({ docId: `pg:${id}:${infos[i].id}`, doc: pdoc });
      threads.push(...summarizeThreads(infos[i].id, page.comments(), page.readings()));
    });
    if (threads.length) nb.putThreads(threads);
    nb.setMeta({ aiAccess, createdAt: created, updatedAt: updated });
    docs.push({ docId: `nb:${id}`, doc });
    entries.push({ id, title, cover, folder, updatedAt: updated, aiAccess, favorite });
    out.notebooks[key] = { id, title, pages: pageInfos, pageDocs, nb };
    return out.notebooks[key];
  }

  // ------------------------------------------------------------------------------------------ Calculus II (PDF)
  const pdfAsset = addAsset(deckPdf, 'application/pdf', 'MATH 201 Lecture 7 - Integration by parts.pdf', { pageCount: 5 });
  const lecStart = at(18, 10, 5);
  const clock = { t: lecStart };
  const tl = []; // lecture timeline events
  const lt = (ms) => ms - lecStart;
  const write = (page, pageId, items) => {
    page.addItems(items);
    // Ink written during the lecture goes on its timeline; a snapped shape lands right after the stroke before it.
    let last = null;
    for (const it of items) {
      if (it.type === 'stroke') last = it.createdAt;
      if ((it.type === 'stroke' || it.type === 'shape') && last >= lecStart && last < lecStart + 50 * 60000) tl.push({ t: lt(last) + (it.type === 'shape' ? 400 : 0), k: 'add', p: pageId, items: [{ ...it }] });
    }
  };
  const blue = new Hand({ seed: 21, clock, color: C.blue, xh: 7.2, width: 1.2 });
  const ink = blue.with({ color: C.graphite });
  const red = blue.with({ color: C.red });
  const teal = blue.with({ color: C.teal });
  const slideInfo = (i) => ({ size: SLIDE, paper: 'blank', paperColor: 'white', background: { kind: 'pdf', assetId: pdfAsset.id, pageIndex: i } });
  const calc = notebook({
    key: 'calc',
    title: 'Calculus II · Lecture 7',
    cover: COVER.indigo,
    paper: 'blank',
    size: SLIDE,
    folder: 'MATH 201',
    favorite: true,
    aiAccess: true,
    created: at(18, 10, 2),
    updated: at(24, 8, 40),
    asset: pdfAsset,
    pages: [
      { info: slideInfo(0) },
      {
        info: slideInfo(1),
        build(page, info) {
          clock.t = lecStart + 6 * 60000 + 12000;
          tl.push({ t: lt(clock.t - 4000), k: 'page', p: info.id, n: 1 });
          const it = [];
          it.push(highlight([43, 252, 328, 270], HL.yellow, clock, 5));
          const lp = red.loop([47, 201, 250, 240], { pad: 5 });
          it.push(lp);
          const a = blue.write('just the product rule,', 470, 150);
          const b = blue.write('integrated!', 470, 168);
          it.push(...a.items, ...b.items, ...blue.arrow([466, 152], [352, 160], { curve: -0.15 }));
          const s = red.write('★ on every exam', 470, 228, { size: 1.15 });
          it.push(...s.items, ...red.arrow([466, 224], [262, 222], { curve: 0.12 }));
          it.push(...ink.write('Pick u so that du', 470, 300).items, ...ink.write('is simpler than u.', 470, 318).items);
          it.push(...ink.write('Then ∫ v du is easier.', 470, 336).items);
          write(page, info.id, it);
          out.slide2Ink = it.filter((x) => x.type === 'stroke').map((x) => x.id);
          out.slide2Loop = [lp.id];
          // No comment thread on this slide: its pin would show in the pdf shot and the hero.
        },
      },
      {
        info: slideInfo(2),
        build(page, info) {
          clock.t = lecStart + 17 * 60000 + 30000;
          tl.push({ t: lt(clock.t - 5000), k: 'page', p: info.id, n: 2 });
          const it = [highlight([44, 95, 312, 113], HL.yellow, clock, 6)];
          it.push(...blue.write('e.g. ∫ x ln x dx', 590, 112).items);
          it.push(...blue.write('u = ln x   (L)', 598, 134).items);
          it.push(...blue.write('dv = x dx  (A)', 598, 154).items);
          const m = teal.write('"Lions In A Tiny Elevator"', 330, 300, { size: 1.15 });
          it.push(...m.items, teal.underline(m.bbox));
          it.push(...teal.arrow([326, 292], [300, 255], { curve: 0.25 }));
          write(page, info.id, it);
        },
      },
      {
        info: slideInfo(3),
        build(page, info) {
          clock.t = lecStart + 28 * 60000;
          tl.push({ t: lt(clock.t - 6000), k: 'page', p: info.id, n: 3 });
          const it = [];
          const du = blue.write('dx', 122, 188, { size: 1.2 });
          const v = blue.write('e^{x}', 288, 188, { size: 1.2 });
          it.push(...du.items, ...v.items);
          blue.pause(20000);
          const l1 = ink.write('∫ x e^{x} dx = x e^{x} − ∫ e^{x} dx', 70, 262, { size: 1.25 });
          const l2 = ink.write('= x e^{x} − e^{x} + C', 129, 292, { size: 1.25 });
          ink.pause(9000);
          const l3 = ink.write('= e^{x} (x − 1) + C', 129, 326, { size: 1.35 });
          it.push(...l1.items, ...l2.items, ...l3.items);
          const box = [l3.bbox[0] - 7, l3.bbox[1] - 6, l3.bbox[2] + 8, l3.bbox[3] + 6];
          const rect = shape('rect', rectPts(box), C.red, 1.4);
          it.push(rect);
          it.push(...teal.write('✓', box[2] + 8, 330, { size: 1.6 }).items);
          write(page, info.id, it);
          out.slide4Answer = [...l3.items.map((x) => x.id), rect.id];
          out.slide4Work = it.filter((x) => x.type === 'stroke').map((x) => x.id);
          // The tutor's threads live on this slide only (the ai shot); the pdf, hero and lecture shots show slides without pins.
          pinned(at(18, 11, 2), () => {
            const fill = [...du.items, ...v.items];
            const box = [Math.min(du.bbox[0], v.bbox[0]), Math.min(du.bbox[1], v.bbox[1]), Math.max(du.bbox[2], v.bbox[2]), Math.max(du.bbox[3], v.bbox[3])];
            const cid = page.addComment({ author: { kind: 'agent', name: TUTOR }, text: 'Both right: $du = dx$ and $v = e^x$. Quick check for the next one: in $\\int x\\cos x\\,dx$, which part is $u$?', anchorIds: fill.map((x) => x.id), anchor: box });
            pinned(at(18, 11, 5), () => page.replyToComment(cid, { kind: 'user', name: STUDENT.name }, 'u = x, so dv = cos x dx?'));
            pinned(at(18, 11, 6), () => page.replyToComment(cid, { kind: 'agent', name: TUTOR }, '**Exactly.** Then $v = \\sin x$, and what is left is one easy integral.'));
          });
          pinned(at(18, 20, 14), () => {
            const cid = page.addComment({ author: { kind: 'user', name: STUDENT.name }, text: 'Why is there only one +C, at the very end?', anchorIds: l2.items.map((x) => x.id), anchor: l2.bbox, ask: true });
            pinned(at(18, 20, 15), () =>
              page.replyToComment(
                cid,
                { kind: 'agent', name: TUTOR },
                'Good question. Each indefinite integral has its own constant, but constants **merge**:\n\n$$x e^x - (e^x + C_1) = x e^x - e^x + C$$\n\nwith $C = -C_1$. So one $+C$ at the end is enough. Your boxed answer $e^x(x-1)+C$ is right ✓',
              ),
            );
          });
        },
      },
      {
        info: slideInfo(4),
        build(page, info) {
          clock.t = at(18, 19, 40);
          const it = [];
          it.push(...blue.write('= x ln x − x + C  ✓', 150, 110).items);
          it.push(
            textBox(
              372,
              52,
              340,
              '### Tabular method for 2.\n\nDifferentiate $u = x^2$: $\\;x^2 \\to 2x \\to 2 \\to 0$\n\nIntegrate $dv = \\sin x\\,dx$: $\\;-\\cos x \\to -\\sin x \\to \\cos x$\n\nMultiply along the diagonals with signs **+ − +**:\n\n$$\\int x^2\\sin x\\,dx = -x^2\\cos x + 2x\\sin x + 2\\cos x + C$$',
              { size: 12 },
            ),
          );
          page.addItems(it);
          out.mdBox = it[it.length - 1].id;
        },
      },
    ],
  });
  // The lecture session (finished): timeline, transcript, no audio (playback plays a missing chunk as silence).
  {
    const sid = uuid(ids);
    const ldoc = new Y.Doc();
    const lec = new LectureDoc(ldoc);
    const durationMs = 49 * 60000 + 37000;
    lec.setMeta({ id: sid, notebookId: calc.id, startedAt: lecStart, durationMs, state: 'stopped', lastT: durationMs, transcriber: 'cloud', title: 'Integration by parts' });
    const events = [{ t: 0, k: 'start', at: lecStart }, { t: 0, k: 'page', p: calc.pages[0], n: 0 }, ...tl.sort((a, b) => a.t - b.t), { t: durationMs, k: 'stop' }];
    lec.appendEvents(events);
    const lines = TRANSCRIPT;
    lec.addTranscript(lines.map(([m, s, text], i) => {
      const t0 = (m * 60 + s) * 1000;
      const next = lines[i + 1];
      const t1 = next ? (next[0] * 60 + next[1]) * 1000 - 300 : t0 + 6000;
      return { t0, t1, text, src: 'cloud' };
    }));
    docs.push({ docId: lectureDocId(calc.id, sid), doc: ldoc });
    lectures.push({ id: sid, notebookId: calc.id, startedAt: lecStart, durationMs, state: 'stopped', title: 'Integration by parts' });
    out.lecture = { id: sid, durationMs };
  }

  // ------------------------------------------------------------------------------------------ Cell biology
  const cellAsset = addAsset(cellPng, 'image/png', 'animal-cell.png');
  {
    const clock = { t: at(20, 14, 10) };
    const h = new Hand({ seed: 31, clock, xh: 7.4, width: 1.15 });
    const t = h.with({ color: C.teal });
    const r = h.with({ color: C.red });
    notebook({
      key: 'bio',
      title: 'Cell Biology',
      cover: COVER.sage,
      paper: 'dotted',
      folder: 'BIO 110',
      favorite: true,
      created: at(3, 9),
      updated: at(23, 16, 20),
      asset: cellAsset,
      pages: [
        {
          build(page) {
            const it = [];
            const title = t.write('The animal cell', 46, 70, { size: 2.6 });
            it.push(...title.items, t.underline(title.bbox, { width: 1.5 }));
            it.push(...h.write('BIO 110 · week 9 · eukaryotic cells', 48, 100, { size: 0.9, color: '#5c5c65' }).items);
            const X = (px) => 96 + px * 0.45, Y = (py) => 150 + py * 0.45;
            it.push({ id: nextId('im'), type: 'image', assetId: cellAsset.id, x: X(0), y: Y(0), w: 405, h: 288 });
            const label = (text, x, y, to, o = {}) => {
              const w = (o.hand ?? h).write(text, x, y, o);
              const from = o.from ?? (to[0] < x ? [x - 4, y - 3] : [w.bbox[2] + 4, y - 3]);
              it.push(...w.items, o.free ? h.line(from, to, { bow: 0.03 }) : shape('arrow', [from, to], C.graphite, 1.1));
              return w;
            };
            // organelle positions in the diagram's own 900 × 640 units (assets.mjs cellSvg)
            label('vesicle', 478, 150, [X(630), Y(128)], { from: [474, 147] });
            label('nucleolus', 478, 222, [X(462), Y(286)], { from: [474, 219] });
            label('rough ER', 478, 292, [X(668), Y(300)], { from: [474, 289] });
            label('cell membrane', 478, 372, [X(818), Y(360)], { from: [474, 369] });
            label('mitochondrion', 20, 205, [X(205), Y(250)], { from: [96, 210] });
            const atp = r.write('(makes ATP!)', 26, 224, { size: 0.9 });
            it.push(...atp.items);
            label('nucleus', 30, 300, [X(318), Y(330)], { from: [78, 297] });
            label('Golgi body', 26, 392, [X(268), Y(450)], { from: [86, 389] });
            label('ribosomes', 250, 472, [X(389), Y(416)], { from: [282, 460] });
            // notes
            const lines = [
              ['Eukaryotic cells split jobs into compartments:', h],
              ['• nucleus: keeps the DNA, makes mRNA', h],
              ['• mitochondria: aerobic respiration → ATP', h],
              ['• rough ER + Golgi: make, fold and ship proteins', h],
              ['• ribosomes: translate mRNA into proteins', h],
            ];
            let y = 530;
            const hl = [];
            for (const [l, hh] of lines) {
              const w = hh.write(l, 48, y);
              it.push(...w.items);
              hl.push(w);
              y += 26;
            }
            it.unshift(highlight([48 + h.measure('• mitochondria: aerobic respiration → '), hl[2].bbox[1] + 1, hl[2].bbox[2] + 1, hl[2].bbox[3] - 1], HL.green, clock, 8));
            const k1 = t.write('Key idea: membranes make compartments,', 64, 700, { size: 1.05 });
            const k2 = t.write('and compartments let the cell control', 64, 724, { size: 1.05 });
            const k3 = t.write('what happens where.', 64, 748, { size: 1.05 });
            it.push(...k1.items, ...k2.items, ...k3.items);
            it.push(shape('rect', rectPts([50, 680, Math.max(k1.bbox[2], k2.bbox[2]) + 16, 762]), C.teal, 1.3));
            it.push(...r.write('★ quiz Fri', 455, 742, { size: 1.1 }).items);
            page.addItems(it);
          },
        },
        {
          build(page) {
            const it = [];
            const title = t.write('Mitochondria', 46, 70, { size: 2.2 });
            it.push(...title.items, t.underline(title.bbox));
            let y = 120;
            for (const l of ['Double membrane: the inner one folds into cristae,', 'which gives a huge surface for the electron', 'transport chain.', '', 'glucose + O_{2} → CO_{2} + H_{2}O + ATP', '', 'They have their own DNA (circular, like bacteria)', '→ endosymbiotic theory.']) {
              if (l) it.push(...h.write(l, 48, y).items);
              y += 26;
            }
            page.addItems(it);
          },
        },
      ],
    });
  }

  // ------------------------------------------------------------------------------------------ Planner
  {
    const clock = { t: at(23, 20, 5) };
    const h = new Hand({ seed: 41, clock, xh: 7.6, width: 1.2 });
    notebook({
      key: 'plan',
      title: 'Planner',
      cover: COVER.sand,
      paper: 'dotted',
      paperColor: 'cream',
      folder: 'Personal',
      created: at(2, 8),
      updated: at(24, 7, 55),
      pages: [
        {
          build(page) {
            const it = [];
            const ttl = h.write('Week 48', 46, 72, { size: 3, color: C.indigo });
            it.push(...ttl.items, ...h.write('24 – 30 November', ttl.x + 16, 72, { size: 1.3, color: '#5c5c65' }).items);
            // sticky notes: highlighter blocks with writing on top
            const sticky = (x, y, w, hgt, col, seed, day, lines, tone = C.graphite) => {
              for (let k = 0, yy = y + 7; yy < y + hgt - 4; k++, yy += 12.5) it.push(highlight([x, yy - 6, x + w, yy + 6], col, clock, seed + k, { width: 14 }));
              it.push(...h.write(day, x + 8, y + 22, { size: 1.35, color: tone }).items);
              lines.forEach((l, i) => it.push(...h.write(l, x + 8, y + 46 + i * 20, { size: 0.95 }).items));
            };
            sticky(46, 104, 150, 112, HL.yellow, 100, 'Mon', ['Calc PS 6 due', 'lab, 2 pm'], C.amber);
            sticky(214, 104, 150, 112, HL.pink, 200, 'Wed', ['French oral', 'practise être verbs!'], C.red);
            sticky(46, 238, 150, 112, HL.green, 300, 'Fri', ['Bio quiz:', 'cell organelles'], C.teal);
            sticky(214, 238, 150, 112, HL.blue, 400, 'Sat', ["Dad's birthday", 'call + cake!'], C.blue);
            it.push(
              textBox(
                388,
                108,
                180,
                '### To do\n\n- ~~Calculus problem set 6~~\n- ~~Bio lab report draft~~\n- Read *The Prince*, ch. 4–6\n- Email Dr. Okafor about office hours\n- Revise **passé composé**\n\n> Calc midterm: **Thu 4 Dec**, 9:00, Hall B',
                { size: 12 },
              ),
            );
            const n = h.write('Goals', 48, 410, { size: 1.6, color: C.indigo });
            it.push(...n.items, h.underline(n.bbox, { color: C.indigo }));
            let y = 446;
            for (const g of ['1. Finish integration by parts exercises', '2. 30 min French every day', '3. Sleep before midnight (!)', '4. Start the history essay outline']) {
              it.push(...h.write(g, 56, y).items);
              y += 26;
            }
            it.push(...h.arrow([330, 486], [400, 520], { color: C.red }));
            it.push(...h.write('really.', 404, 530, { color: C.red }).items);
            page.addItems(it);
          },
        },
      ],
    });
  }

  // ------------------------------------------------------------------------------------------ French
  {
    const clock = { t: at(21, 16, 30) };
    const h = new Hand({ seed: 51, clock, xh: 7.2, width: 1.15 });
    const fancy = new Hand({ font: 'EMSAllure', seed: 52, clock, xh: 8.5, width: 1.25, color: C.indigo });
    const r = h.with({ color: C.red });
    notebook({
      key: 'french',
      title: 'Français',
      cover: COVER.rose,
      paper: 'ruled',
      paperColor: 'cream',
      folder: 'Autumn term',
      created: at(5, 9),
      updated: at(22, 18, 10),
      pages: [
        {
          build(page) {
            const it = [];
            const B = (k) => 72 + 24 * k - 2; // baseline on rule k
            it.push(...fancy.write('Le passé composé', 46, B(0) - 6, { size: 2.4 }).items);
            const f1 = h.write('avoir / être + participe passé', 52, B(2), { size: 1.15 });
            it.unshift(highlight(f1.bbox, HL.yellow, clock, 61));
            it.push(...f1.items);
            const ex = [
              ["J'ai mangé une pomme.", '(manger → mangé)'],
              ['Nous avons fini nos devoirs.', '(finir → fini)'],
              ['Ils ont vendu la voiture.', '(vendre → vendu)'],
            ];
            ex.forEach(([a, b], i) => {
              it.push(...h.write(a, 52, B(3 + i)).items);
              it.push(...h.write(b, 330, B(3 + i), { color: '#5c5c65' }).items);
            });
            it.push(...fancy.write('Les verbes avec être', 46, B(7), { size: 1.6, color: C.teal }).items);
            const dr = h.write('DR MRS VANDERTRAMP', 52, B(8), { size: 1.1, color: C.teal });
            it.unshift(highlight(dr.bbox, HL.green, clock, 62));
            it.push(...dr.items);
            const verbs = ['devenir', 'revenir', 'monter', 'rester', 'sortir', 'venir', 'aller', 'naître', 'descendre', 'entrer', 'rentrer', 'tomber', 'retourner', 'arriver', 'mourir', 'partir'];
            const vids = [];
            verbs.forEach((v, i) => {
              const w = h.write(v, 60 + (i % 4) * 128, B(9 + Math.floor(i / 4)));
              it.push(...w.items);
              vids.push(...w.items.map((x) => x.id));
            });
            out.frenchVerbs = vids;
            const acc = r.write('Accord !', 52, B(14), { size: 1.2 });
            it.push(...acc.items);
            const e1 = h.write('Elle est allée au marché.', 140, B(14));
            const e2 = h.write('Ils sont partis à huit heures.', 140, B(15));
            it.push(...e1.items, ...e2.items);
            const ax = 140 + h.measure('Elle est ');
            it.push(r.loop([ax - 1, e1.bbox[1] + 3, ax + h.measure('allée') + 1, e1.bbox[3] - 2], { pad: 3 }));
            it.push(...h.write('Attention : verbes pronominaux → être aussi', 52, B(17)).items);
            it.push(...h.write('(je me suis levé, elle s’est réveillée)', 70, B(18), { color: '#5c5c65' }).items);
            it.push(...r.arrow([480, B(17) - 30], [440, B(17) - 8], { curve: 0.2 }));
            it.push(...r.write('exam!', 486, B(16) - 2).items);
            page.addItems(it);
          },
        },
      ],
    });
  }

  // ------------------------------------------------------------------------------------------ Physics (ruler shot)
  {
    const clock = { t: at(19, 11, 0) };
    const h = new Hand({ seed: 71, clock, xh: 7.4, width: 1.15 });
    const b = h.with({ color: C.blue });
    notebook({
      key: 'physics',
      title: 'Physics · Waves & Optics',
      cover: COVER.blue,
      paper: 'grid',
      folder: 'Autumn term',
      created: at(4, 9),
      updated: at(19, 12, 30),
      pages: [
        {
          build(page) {
            const it = [];
            const ttl = b.write("Refraction · Snell's law", 46, 70, { size: 2.2 });
            it.push(...ttl.items, b.underline(ttl.bbox));
            it.push(...h.write('n_{1} sin θ_{1} = n_{2} sin θ_{2}', 60, 118, { size: 1.4 }).items);
            // interface and normal
            const cx = 300, cy = 380;
            it.push(shape('line', [[90, cy], [510, cy]], C.graphite, 1.4));
            for (let y = 230; y < 540; y += 14) it.push(h.line([cx, y], [cx, y + 7], { color: '#5c5c65', width: 0.9 }));
            for (let k = 0, y = cy + 10; y < 530; k++, y += 12) it.push(highlight([92, y - 5, 508, y + 5], HL.blue, clock, 80 + k, { width: 12 }));
            // incident ray along 35°
            const a1 = (35 * Math.PI) / 180;
            const p0 = [cx - Math.sin(a1) * 190, cy - Math.cos(a1) * 190];
            it.push(shape('arrow', [p0, [cx - 2, cy - 2]], C.red, 1.6));
            it.push(...h.write('air,  n_{1} = 1.00', 380, 260).items);
            it.push(...h.write('glass,  n_{2} = 1.50', 380, 500).items);
            it.push(...h.write('θ_{1} = 35°', 230, 300, { color: C.red }).items);
            it.push(...h.write('normal', 312, 228, { color: '#5c5c65', size: 0.9 }).items);
            it.push(...h.write('sin θ_{2} = sin 35° / 1.5 ≈ 0.38  →  θ_{2} ≈ 22.5°', 60, 600).items);
            it.push(...h.write('Light bends towards the normal going into', 60, 640).items);
            it.push(...h.write('a denser medium (it slows down).', 60, 664).items);
            page.addItems(it);
          },
        },
      ],
    });
  }

  // ------------------------------------------------------------------------------------------ Quieter notebooks
  const simple = (key, title, cover, folder, d, lines, o = {}) => {
    const clock = { t: at(d, 15) };
    const h = new Hand({ seed: d * 7, clock, xh: 7.2, width: 1.15, ...(o.hand ?? {}) });
    notebook({
      key,
      title,
      cover,
      folder,
      paper: o.paper ?? 'ruled',
      paperColor: o.paperColor ?? 'white',
      created: at(d - 6, 9),
      updated: at(d, 17),
      favorite: o.favorite,
      pages: [
        {
          build(page) {
            const it = [];
            const ttl = h.write(lines[0], 46, 64, { size: 2, color: o.color ?? C.indigo });
            it.push(...ttl.items, h.underline(ttl.bbox, { color: o.color ?? C.indigo }));
            lines.slice(1).forEach((l, i) => l && it.push(...h.write(l, 50, 118 + 24 * i).items));
            page.addItems(it);
          },
        },
      ],
    });
  };
  simple('linalg', 'Linear Algebra', COVER.graphite, 'Autumn term', 17, ['Eigenvalues', 'A v = λ v  with v ≠ 0', 'det(A − λI) = 0 gives the characteristic polynomial', 'Trace = sum of λ,  det = product of λ']);
  simple('chem', 'Organic Chemistry', COVER.teal, 'Autumn term', 14, ['Alkenes', 'C=C double bond: one σ and one π bond', 'Addition reactions: HBr, H_{2}O, Br_{2}', "Markovnikov's rule: H goes to the carbon with more H"], { color: C.teal });
  simple('reading', 'Reading journal', COVER.paper, 'Personal', 12, ['The Prince, ch. 1–3', '"It is better to be feared than loved,', 'if you cannot be both."', 'Is Machiavelli describing or prescribing?'], { paperColor: 'cream', color: C.amber });

  // ------------------------------------------------------------------------------------------ the library doc
  const libDoc = new Y.Doc();
  const lib = new Library(libDoc);
  const folders = {};
  for (const name of ['Autumn term', 'MATH 201', 'BIO 110', 'Personal']) folders[name] = pinned(at(1, 9), () => lib.addFolder(name));
  for (const e of entries) lib.putEntry({ id: e.id, title: e.title, cover: e.cover, folderId: e.folder ? folders[e.folder] : null, updatedAt: e.updatedAt, aiAccess: e.aiAccess, favorite: !!e.favorite, deletedAt: null });
  for (const l of lectures) lib.putLecture(l);

  return { docs, assets, libDoc, out, folders };
}

/** What Dr. Okafor said (made up), [minute, second, text]. */
const TRANSCRIPT = [
  [0, 4, 'Okay, good morning everyone, let’s get started.'],
  [0, 31, 'Today is integration by parts, which is really just the product rule run in reverse.'],
  [2, 10, 'Last week we did substitution, which undoes the chain rule.'],
  [5, 2, 'So, the product rule: the derivative of u times v is u prime v plus u v prime.'],
  [5, 48, 'Integrate both sides, and the left side just gives back u v.'],
  [6, 30, 'Rearrange, and you get the formula: the integral of u dv equals u v minus the integral of v du.'],
  [7, 15, 'This one is on every exam. Every single one. Write it down.'],
  [8, 2, 'The whole game is trading an integral you can’t do for one you can.'],
  [12, 40, 'Now, the hard part is choosing u. If you choose badly the new integral gets worse.'],
  [17, 5, 'There’s a mnemonic for it: LIATE. Logarithmic, inverse trig, algebraic, trig, exponential.'],
  [17, 50, 'Whichever type comes first in that list, call it u. The rest is dv.'],
  [18, 36, 'So for x ln x, the log comes first: u is ln x, dv is x dx.'],
  [19, 20, 'Some of you remember it as “Lions In A Tiny Elevator”. Whatever works.'],
  [24, 11, 'Right, let’s do one together. The integral of x e to the x, dx.'],
  [25, 2, 'Algebraic beats exponential, so u is x and dv is e to the x dx.'],
  [26, 15, 'Then du is just dx, and v is e to the x. Fill in the table.'],
  [28, 3, 'Plug into the formula: x e to the x, minus the integral of e to the x dx.'],
  [28, 40, 'And that last integral is easy, it’s e to the x again.'],
  [29, 12, 'So we get x e to the x minus e to the x, plus C.'],
  [29, 55, 'You can factor it: e to the x times x minus one, plus C. Always check by differentiating.'],
  [31, 20, 'Question at the back? Yes, the constant. We’ll only write one C, I’ll come back to that.'],
  [34, 8, 'Now try the four on the next slide. The first one is a classic: the integral of ln x.'],
  [36, 30, 'Hint: write ln x as ln x times one, and let dv be dx.'],
  [41, 2, 'For number two you need to integrate by parts twice. Or use the tabular method.'],
  [47, 45, 'Okay, that’s time. Problem set six is due Monday. See you Thursday.'],
];
