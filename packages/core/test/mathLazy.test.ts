import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import type * as Core from '../src';
import type { MdLayout } from '../src';
import type { RegionRow } from '../src/render/regions';
import { MATH_GOLDEN_INPUTS } from './mathGoldenInputs';
import { newNotebook } from './helpers';

declare const process: {
  getBuiltinModule(m: 'node:fs'): { readFileSync(path: string, enc: 'utf8'): string; readdirSync(path: string, o: { recursive: true }): string[] };
};

/**
 * MathJax loads on demand (`src/markdown/math.ts`). Every test starts from freshly imported modules, so MathJax isn't
 * loaded; the probe counts loads of the module that imports it (vitest evaluates a mocked module once per file, so the
 * tests that must not load it run first).
 */
const probe = vi.hoisted(() => ({ loads: 0 }));
vi.mock('../src/markdown/mathjax', async (importOriginal) => {
  probe.loads++;
  return importOriginal();
});

type Fresh = typeof Core & {
  renderRegionsSvg: typeof import('../src/render/regions').renderRegionsSvg;
  MATH_LOADER: typeof import('../src/markdown/math').MATH_LOADER;
  MATH_RETRY: typeof import('../src/markdown/math').MATH_RETRY;
};

async function fresh(): Promise<Fresh> {
  vi.resetModules();
  probe.loads = 0;
  const math = await import('../src/markdown/math');
  return { ...(await import('../src')), ...(await import('../src/render/regions')), MATH_LOADER: math.MATH_LOADER, MATH_RETRY: math.MATH_RETRY };
}

declare function setTimeout(cb: () => void, ms: number): unknown;
declare const performance: { now(): number };

/** Lets a started `import()` settle. */
const settle = () => new Promise<void>((r) => setTimeout(r, 20));

const md = (text: string, extra: Partial<Core.TextItem> = {}): Core.TextItem => ({ id: `t${text.length}`, type: 'text', x: 40, y: 60, w: 240, text, fontSize: 16, color: '#27272a', format: 'md', ...extra });
const INFO: Core.PageInfo = { id: 'p', size: { w: 595, h: 842 }, paper: 'blank', paperColor: 'white', background: { kind: 'paper' } };
const ROW: RegionRow = { pageId: 'p', label: '[1]', box: [30, 50, 400, 400], fresh: [], context: [], erased: [], clip: true, unit: 20 };

const fontsOf = (doc: PDFDocument) =>
  doc.context
    .enumerateIndirectObjects()
    .map(([, o]) => o)
    .filter((o): o is PDFDict => o instanceof PDFDict && o.get(PDFName.of('Type')) === PDFName.of('Font'))
    .map((d) => String(d.get(PDFName.of('BaseFont'))));

describe('MathJax loads only for maths', () => {
  it('is imported by math.ts alone, and only with import(), so bundles can leave it out', () => {
    const fs = process.getBuiltinModule('node:fs');
    const sources = (dir: string) =>
      fs
        .readdirSync(dir, { recursive: true })
        .map((f) => f.replace(/\\/g, '/'))
        .filter((f) => /\.(tsx?|mjs|js)$/.test(f) && !f.includes('node_modules/'))
        .map((f) => ({ path: f, src: fs.readFileSync(`${dir}/${f}`, 'utf8') }));
    // Core's engine module, as any relative specifier (`./mathjax`, `../markdown/mathjax.js`, …).
    const engine = String.raw`['"](?:\.{1,2}/)+(?:markdown/)?mathjax(?:\.[jt]s)?['"]`;
    // Static imports would put MathJax in every bundle: `from '…'`, a bare `import '…'`, or `require('…')`.
    const statically = new RegExp(String.raw`(?:\bfrom\s*|\bimport\s+|\brequire\(\s*)${engine}`);
    const dynamically = new RegExp(String.raw`\bimport\(\s*${engine}\s*\)`);
    let seen = 0;
    for (const { path, src } of sources('src')) {
      if (path !== 'markdown/mathjax.ts') expect(src, path).not.toMatch(/mathjax-full/);
      expect(src, path).not.toMatch(statically);
      if (path === 'markdown/math.ts') seen += src.match(new RegExp(dynamically, 'g'))?.length ?? 0;
      else expect(src, path).not.toMatch(dynamically);
    }
    expect(seen, 'math.ts has the one import()').toBe(1);
    // Nor may the app, the server or the native modules reach MathJax, or core's engine, on their own.
    const outside = ['app', 'server', 'desktop'].map((a) => `../../apps/${a}/src`).concat('../../modules/qalm-ink/src');
    for (const dir of outside) for (const { path, src } of sources(dir)) expect(src, `${dir}/${path}`).not.toMatch(/mathjax-full|markdown\/mathjax\b/);
  });

  it('never loads for notes, Markdown, crops or PDFs without maths', async () => {
    const core = await fresh();
    const page = new core.Page(new Y.Doc());
    const items = [
      md('# Title\n\n**b** *i* ~~s~~ `$x$` [l](https://a.b)\n\n- costs $5 and $6\n\n> q\n\n```\n$$ not maths $$\n```'),
      // A plain box (no `format`) is never Markdown, dollars or not.
      { ...md('$x^2$ and $$y$$'), id: 'plain', format: undefined },
    ];
    for (const it of items) page.addItem(it);
    expect(items.map((it) => core.markdownNeedsMath(it.text))).toEqual([false, true]);
    expect(core.layoutMarkdown(items[0]!.text, 240, 16).pending).toBeUndefined();
    expect(core.textHeight(items[0]!)).toBeGreaterThan(16 * 1.3 * 4);
    core.itemBBox(items[1]!);
    core.renderPageSvg(INFO, page);
    core.renderRegionsSvg({ p: page }, [ROW]);
    await core.loadMathFor(page.items());
    await core.exportPdf(newNotebook(), async () => page, async () => new Uint8Array());
    // Comments: previews and parsing don't lay maths out.
    core.markdownToPlain('see $x^2$');
    core.parseMarkdown('$$\\int x$$');
    await settle();
    expect(probe.loads).toBe(0);
    expect(core.mathReady()).toBe(false);
  });

  it('never loads for maths past the limits: those formulas show their source either way', async () => {
    const core = await fresh();
    const tooLong = `$${'x'.repeat(core.MATH_LIMITS.texChars + 1)}$`;
    // Display maths over the cap, in a list.
    const display = `- item\n\n  $${tooLong}$`;
    const page = new core.Page(new Y.Doc());
    for (const [k, text] of [tooLong, display].entries()) page.addItem({ ...md(text), id: `b${k}` });
    for (const text of [tooLong, display]) {
      expect(core.markdownNeedsMath(text)).toBe(false);
      const l = core.layoutMarkdown(text, 4000, 16);
      expect(l.pending).toBeUndefined();
      // Shown as code (the TeX-error style), not as the muted placeholder.
      expect(l.ops.some((o) => o.k === 'text' && o.alpha !== undefined)).toBe(false);
      expect(l.ops.some((o) => o.k === 'rect')).toBe(true);
    }
    expect(core.texToPath('x'.repeat(core.MATH_LIMITS.texChars + 1), false)).toBeNull();
    await core.loadMathFor(page.items());
    await core.exportPdf(newNotebook(), async () => page, async () => new Uint8Array());
    // A comment's formula past the cap isn't drawn either (the app asks `allowedMath` first), and doesn't load MathJax.
    expect(core.allowedMath(core.parseMarkdown(tooLong)).size).toBe(0);
    await settle();
    expect(probe.loads).toBe(0);
    expect(core.mathReady()).toBe(false);
  });

  it('shows maths as its raw TeX until MathJax loads, then lays out exactly as before it loaded on demand', async () => {
    const core = await fresh();
    const ready = vi.fn();
    core.onMathReady(ready);
    const [text, w, size] = MATH_GOLDEN_INPUTS.layouts[0]!;
    const before = core.layoutMarkdown(text, w, size);
    expect(before.pending).toBe(true);
    expect(before.ops.some((o) => o.k === 'path')).toBe(false);
    // The placeholder: the TeX in muted monospace, inline with the words around it.
    const raw = before.ops.filter((o) => o.k === 'text' && o.alpha !== undefined);
    expect(raw.map((o) => o.k === 'text' && o.text).join(' ')).toMatch(/\$E = mc\^2\$.*\\frac\{a\}\{b\}\$/);
    expect(raw.every((o) => o.k === 'text' && o.font !== 'r' && o.alpha! < 1)).toBe(true);
    expect(before.ops.some((o) => o.k === 'text' && o.alpha === undefined && o.text.includes('Energy'))).toBe(true);
    // Display maths' placeholder is centred on its own line.
    const display = core.layoutMarkdown('$$\\int_0^1 x\\,dx$$', 300, 16);
    const op = display.ops.find((o) => o.k === 'text')!;
    expect(op.k === 'text' && op.text).toContain('$$\\int_0^1');
    expect(op.x).toBeGreaterThan(20);
    expect(core.texToPath('x', false)).toBeUndefined();
    // Drawing maths started loading MathJax.
    await core.loadMath();
    expect(probe.loads).toBe(1);
    expect(ready).toHaveBeenCalledTimes(1);
    expect(core.mathReady()).toBe(true);
    // The same layouts as the synchronous MathJax code made (fixtures/mathGolden.json), the cached placeholder included.
    const golden = JSON.parse(process.getBuiltinModule('node:fs').readFileSync('test/fixtures/mathGolden.json', 'utf8')) as { layouts: MdLayout[]; boxes: (Core.MathBox | null)[] };
    MATH_GOLDEN_INPUTS.layouts.forEach(([t, w, s], i) => expect(core.layoutMarkdown(t, w, s), t).toEqual(golden.layouts[i]));
    MATH_GOLDEN_INPUTS.tex.forEach(([t, d], i) => expect(core.texToPath(t, d), t).toEqual(golden.boxes[i]));
    expect(probe.loads).toBe(1);
  });

  it('the caps, the budget and the per-formula reset hold across the placeholder → maths swap', async () => {
    const core = await fresh();
    // One box with more formulas than its allowance: before MathJax, the allowed ones are placeholders, the rest source.
    const many = Array.from({ length: core.MATH_LIMITS.perDoc + 5 }, (_, i) => `$x_{${i}}$`).join(' ');
    const before = core.layoutMarkdown(many, 4000, 16);
    expect(before.pending).toBe(true);
    const muted = before.ops.filter((o) => o.k === 'text' && o.alpha !== undefined).map((o) => (o.k === 'text' ? o.text : '')).join(' ');
    expect(muted).toContain(`x_{${core.MATH_LIMITS.perDoc - 1}}`);
    expect(muted).not.toContain(`x_{${core.MATH_LIMITS.perDoc}}`);
    await core.loadMath();
    // After: exactly the allowance is drawn as maths, the rest as source, from the replaced cached layout.
    const after = core.layoutMarkdown(many, 4000, 16);
    expect(after.pending).toBeUndefined();
    expect(after.ops.filter((o) => o.k === 'path')).toHaveLength(core.MATH_LIMITS.perDoc);
    expect(after.ops.some((o) => o.k === 'text' && o.text.includes(`x_{${core.MATH_LIMITS.perDoc + 2}}`))).toBe(true);
    // Too-big outlines are refused by the engine too.
    expect(core.texToPath('x+'.repeat(500), false)).toBeNull();
    // A placeholder laid out under a budget becomes maths only as far as the budget goes, and isn't cached.
    const text = '$lazya+b$ and $lazyc+d$';
    const reset = await fresh();
    expect(reset.layoutMarkdown(text, 400, 16).pending).toBe(true);
    await reset.loadMath();
    const cut = reset.withMathBudget({ chars: 10, ms: 60_000 }, () => reset.layoutMarkdown(text, 400, 16));
    expect(cut.ops.filter((o) => o.k === 'path')).toHaveLength(1);
    expect(reset.layoutMarkdown(text, 400, 16).ops.filter((o) => o.k === 'path')).toHaveLength(2);
    // What a formula defines is forgotten after it, on the lazy engine too.
    const frac = reset.texToPath('\\frac{c}{d} ', false)!;
    reset.texToPath('\\DeclareMathOperator{\\frac}{Z}\\frac', false);
    expect(reset.texToPath('\\frac{c}{d}', false)!.path).toBe(frac.path);
  });

  it('PDF export and crops load MathJax first, so they never draw the placeholder', async () => {
    let core = await fresh();
    let page = new core.Page(new Y.Doc());
    page.addItem(md('area $\\int_0^1 x^2\\,dx$'));
    // (vitest reuses a mocked module after resetModules, so the probe counts once per file: check the fresh seam.)
    expect(core.mathReady()).toBe(false);
    // No mono font: the placeholder would have been drawn in Geist Mono.
    const pdf = await PDFDocument.load(await core.exportPdf(newNotebook(), async () => page, async () => new Uint8Array()));
    expect(core.mathReady()).toBe(true);
    expect(fontsOf(pdf).some((n) => n.includes('GeistMono'))).toBe(false);

    // The server loads it for its pages (`loadMathFor`) before measuring regions and drawing crops.
    core = await fresh();
    page = new core.Page(new Y.Doc());
    page.addItem(md('area $\\int_0^1 x^2\\,dx$'));
    expect(core.mathReady()).toBe(false);
    await core.loadMathFor(page.items());
    expect(core.mathReady()).toBe(true);
    const { svg } = core.renderRegionsSvg({ p: page }, [ROW]);
    expect(svg).toContain('<path transform=');
    expect(svg).not.toContain('fill-opacity="0.55"');
  });
});

declare const EventTarget: new () => { dispatchEvent(e: object): boolean };
declare const Event: new (type: string) => object;

describe('when MathJax can’t load (offline web, or its chunk gone after a deploy)', () => {
  const failing = () => vi.fn(() => Promise.reject(new Error('Loading chunk mathjax failed')));
  const T0 = 1_000_000;

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as { window?: unknown }).window;
  });

  it('a PDF export still succeeds: its maths is drawn as TeX source, as a TeX error is', async () => {
    const core = await fresh();
    const load = failing();
    core.MATH_LOADER.load = load;
    const text = 'area $\\int_0^1 x^2\\,dx$';
    // The page drew the box first: a placeholder layout is cached.
    expect(core.layoutMarkdown(text, 240, 16).pending).toBe(true);
    const page = new core.Page(new Y.Doc());
    page.addItem(md(text));
    const pdf = await PDFDocument.load(await core.exportPdf(newNotebook(), async () => page, async () => new Uint8Array()));
    expect(pdf.getPageCount()).toBe(1);
    expect(load).toHaveBeenCalled();
    expect(core.mathReady()).toBe(false);
    // The source in code style (Geist Mono), not the placeholder: drawn without the cached placeholder layout.
    expect(fontsOf(pdf).some((n) => n.includes('GeistMono'))).toBe(true);
    const sourced = core.withoutMathPlaceholders(() => core.layoutMarkdown(text, 240, 16));
    expect(sourced.pending).toBeUndefined();
    expect(sourced.ops.some((o) => o.k === 'rect')).toBe(true);
    expect(sourced.ops.some((o) => o.k === 'text' && o.alpha !== undefined)).toBe(false);
    // That source-only layout wasn't cached: the page keeps its placeholder, and gets maths once MathJax loads.
    expect(core.layoutMarkdown(text, 240, 16).pending).toBe(true);
  });

  it('cached placeholders try again, backing off after each failure, and get their maths once a load works', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const core = await fresh();
    let fail = true;
    const load = vi.fn(() => (fail ? Promise.reject(new Error('offline')) : import('../src/markdown/mathjax')));
    core.MATH_LOADER.load = load;
    const text = 'offline $a^2$';
    expect(core.layoutMarkdown(text, 240, 16).pending).toBe(true);
    await settle();
    expect(load).toHaveBeenCalledTimes(1);
    // Within the backoff (5 s): cache hits, other placeholders and comments don't add requests.
    for (let i = 0; i < 20; i++) core.layoutMarkdown(text, 240, 16);
    core.layoutMarkdown('other $b$', 240, 16);
    expect(core.texToPath('c', false)).toBeUndefined();
    await settle();
    expect(load).toHaveBeenCalledTimes(1);
    // After it, a cache hit tries again; it fails, and the wait doubles (10 s).
    vi.setSystemTime(T0 + core.MATH_RETRY.firstMs + 1);
    core.layoutMarkdown(text, 240, 16);
    await settle();
    expect(load).toHaveBeenCalledTimes(2);
    vi.setSystemTime(T0 + core.MATH_RETRY.firstMs + 1 + core.MATH_RETRY.firstMs + 1);
    core.layoutMarkdown(text, 240, 16);
    await settle();
    expect(load).toHaveBeenCalledTimes(2);
    // Past the doubled wait, with the network back: a cache hit loads MathJax, and the layouts get their maths.
    fail = false;
    const ready = vi.fn();
    core.onMathReady(ready);
    vi.setSystemTime(T0 + 3 * core.MATH_RETRY.firstMs + 3);
    expect(core.layoutMarkdown(text, 240, 16).pending).toBe(true);
    await vi.waitFor(() => expect(core.mathReady()).toBe(true));
    expect(load).toHaveBeenCalledTimes(3);
    expect(ready).toHaveBeenCalledTimes(1);
    for (const t of [text, 'other $b$']) {
      const l = core.layoutMarkdown(t, 240, 16);
      expect(l.pending).toBeUndefined();
      expect(l.ops.some((o) => o.k === 'path')).toBe(true);
    }
  });

  it('the browser coming back online retries at once, and resets the backoff', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const win = new EventTarget();
    (globalThis as { window?: unknown }).window = win;
    const core = await fresh();
    let fail = true;
    const load = vi.fn(() => (fail ? Promise.reject(new Error('offline')) : import('../src/markdown/mathjax')));
    core.MATH_LOADER.load = load;
    core.layoutMarkdown('net $x$', 240, 16);
    await settle();
    expect(load).toHaveBeenCalledTimes(1);
    // Still offline: the event retries (at once, inside the backoff), fails, and the backoff starts again from 5 s.
    win.dispatchEvent(new Event('online'));
    await settle();
    expect(load).toHaveBeenCalledTimes(2);
    vi.setSystemTime(T0 + core.MATH_RETRY.firstMs + 1);
    core.layoutMarkdown('net $x$', 240, 16);
    await settle();
    expect(load).toHaveBeenCalledTimes(3);
    fail = false;
    win.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(core.mathReady()).toBe(true));
    expect(load).toHaveBeenCalledTimes(4);
    expect(core.layoutMarkdown('net $x$', 240, 16).ops.some((o) => o.k === 'path')).toBe(true);
  });

  it('an explicit load (PDF export, the server) always tries, backoff or not', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const core = await fresh();
    const load = failing();
    core.MATH_LOADER.load = load;
    await expect(core.loadMath()).rejects.toThrow('Loading chunk');
    await expect(core.loadMath()).rejects.toThrow('Loading chunk');
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe('the lazy load and the app’s time slice (setMathTimeSlice)', () => {
  /** One macrotask: the slice's end runs, and with it the `onMathDeferred` listeners. */
  const task = () => new Promise<void>((r) => setTimeout(r, 0));
  const many = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `$${tag}_{${i}}+1$`).join(' ');
  const paths = (l: Core.MdLayout) => l.ops.filter((o) => o.k === 'path').length;

  it('a box waits on MathJax, then on its slices, and converges: no livelock, no redraws once filled in', async () => {
    const core = await fresh();
    // Every task renders only its first new formula: the slowest fill-in there is.
    core.setMathTimeSlice(0);
    const fills = vi.fn();
    core.onMathDeferred(fills);
    const text = many(6, 'conv');
    // Waiting on MathJax: placeholders, and no slice is used up for them.
    const first = core.layoutMarkdown(text, 4000, 16);
    expect(first.pending).toBe(true);
    expect(paths(first)).toBe(0);
    await core.loadMath();
    // MathJax's arrival is a fill-in like any other: one signal, the epoch moves.
    expect(fills).toHaveBeenCalledTimes(1);
    expect(core.mathDeferredEpoch()).toBe(1);
    // Each render a listener asks for fills in one more formula, until the box is complete.
    let l = core.layoutMarkdown(text, 4000, 16);
    let renders = 1;
    while (paths(l) < 6 && renders < 20) {
      await task();
      l = core.layoutMarkdown(text, 4000, 16);
      renders++;
    }
    expect(paths(l)).toBe(6);
    expect(l.pending).toBeUndefined();
    expect(renders).toBeGreaterThan(1);
    expect(renders).toBeLessThanOrEqual(7);
    // Complete: cached, and nothing asks for another render.
    const calls = fills.mock.calls.length;
    for (let i = 0; i < 3; i++) {
      expect(core.layoutMarkdown(text, 4000, 16)).toBe(l);
      await task();
    }
    expect(fills.mock.calls.length).toBe(calls);
  });

  it('comments: formulas waiting on MathJax are allowed (placeholders), then fill in under the slice', async () => {
    const core = await fresh();
    core.setMathTimeSlice(0);
    const blocks = core.parseMarkdown(many(4, 'cmt'));
    // Before MathJax: every formula within the allowance is in the set; each draws its placeholder.
    expect(core.allowedMath(blocks).size).toBe(4);
    await core.loadMath();
    let allowed = core.allowedMath(blocks);
    for (let i = 0; allowed.size < 4 && i < 20; i++) {
      await task();
      allowed = core.allowedMath(blocks);
    }
    expect(allowed.size).toBe(4);
  });

  it('PDF export loads MathJax and waits out every slice; offline, it draws sources at once instead', async () => {
    let core = await fresh();
    core.setMathTimeSlice(0);
    const text = many(8, 'pdf');
    expect(core.layoutMarkdown(text, 4000, 16).pending).toBe(true);
    let page = new core.Page(new Y.Doc());
    page.addItem(md(text, { w: 4000 }));
    let pdf = await PDFDocument.load(await core.exportPdf(newNotebook(), async () => page, async () => new Uint8Array()));
    // Every formula as outlines: none fell back to its source (which would embed Geist Mono).
    expect(fontsOf(pdf).some((n) => n.includes('GeistMono'))).toBe(false);
    expect(paths(await core.layoutMarkdownSettled(text, 4000, 16))).toBe(8);

    // Offline: no waiting on slices or loads that can't come (and one try for the whole export).
    core = await fresh();
    core.setMathTimeSlice(0);
    const load = vi.fn(() => Promise.reject(new Error('offline')));
    core.MATH_LOADER.load = load;
    page = new core.Page(new Y.Doc());
    for (let k = 0; k < 5; k++) page.addItem(md(text, { id: `box${k}`, y: 60 + k * 40, w: 4000 }));
    const t0 = performance.now();
    pdf = await PDFDocument.load(await core.exportPdf(newNotebook(), async () => page, async () => new Uint8Array()));
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(load).toHaveBeenCalledTimes(1);
    expect(fontsOf(pdf).some((n) => n.includes('GeistMono'))).toBe(true);
    const settled = await core.layoutMarkdownSettled(text, 4000, 16);
    expect(settled.pending).toBeUndefined();
    expect(paths(settled)).toBe(0);
  });

  it('a placeholder layout evicted from the size-bounded cache still asks for MathJax when drawn again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    try {
      const core = await fresh();
      const saved = { ...core.LAYOUT_CACHE };
      core.LAYOUT_CACHE.count = 1;
      try {
        let fail = true;
        const load = vi.fn(() => (fail ? Promise.reject(new Error('offline')) : import('../src/markdown/mathjax')));
        core.MATH_LOADER.load = load;
        expect(core.layoutMarkdown('evict $e^1$', 240, 16).pending).toBe(true);
        await settle();
        expect(load).toHaveBeenCalledTimes(1);
        // Another box pushes it out of the cache.
        core.layoutMarkdown('another box', 240, 16);
        fail = false;
        vi.setSystemTime(1_000_000 + core.MATH_RETRY.firstMs + 1);
        // Laid out afresh (not a cache hit): its formula asks for MathJax again, and it loads.
        expect(core.layoutMarkdown('evict $e^1$', 240, 16).pending).toBe(true);
        await vi.waitFor(() => expect(core.mathReady()).toBe(true));
        expect(load).toHaveBeenCalledTimes(2);
        expect(paths(core.layoutMarkdown('evict $e^1$', 240, 16))).toBe(1);
      } finally {
        Object.assign(core.LAYOUT_CACHE, saved);
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
