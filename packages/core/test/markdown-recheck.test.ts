import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { PDFDocument } from 'pdf-lib';
import {
  Page,
  clusters,
  exportPdf,
  itemBBox,
  layoutMarkdown,
  layoutMarkdownSettled,
  markdownToPlain,
  mathAllowance,
  mathDeferredEpoch,
  onMathDeferred,
  setFallbackTextMeasure,
  setMathTimeSlice,
  loadMath,
  texToPath,
  texToPlain,
  textMetricsEpoch,
  textWidth,
  LAYOUT_CACHE,
  MATH_LIMITS,
  type TextItem,
} from '../src';
import { MAX_CLUSTER, MAX_MARKS } from '../src/markdown/fonts';
import { newNotebook } from './helpers';

declare const performance: { now(): number };
declare const setTimeout: (fn: (v?: unknown) => void, ms: number) => unknown;

// MathJax loads on demand (mathLazy.test.ts covers the time slice before it has): these tests render with it loaded.
beforeAll(() => loadMath());
const tick = () => new Promise((r) => setTimeout(r, 0));
/**
 * Linear, not quadratic: laying out twice the input takes at most ~2.5× as long (best of 3 runs each, each at its own
 * width so the layout cache can't answer; a few ms of slack for timer noise), and stays well under 500 ms. Robust under
 * load, where fixed limits like "under 100 ms" were flaky.
 */
const expectLinear = (make: (n: number) => string, n: number) => {
  let run = 0;
  const best = (text: string) => Math.min(...[0, 1, 2].map(() => time(() => layoutMarkdown(text, 200 + ++run / 100, 16))));
  const t1 = best(make(n));
  const t2 = best(make(2 * n));
  expect(t2).toBeLessThan(2.5 * t1 + 10);
  expect(t2).toBeLessThan(500);
};
const time = (fn: () => void) => {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
};
const paths = (text: string, w = 100_000) => layoutMarkdown(text, w, 16).ops.filter((o) => o.k === 'path').length;
/** A 10 × 10 matrix of W: ~166 KB of path, under the per-formula caps (200 KB, 50 em). */
const grid = (last: string) =>
  '\\begin{matrix}' +
  Array.from({ length: 10 }, (_, r) => Array.from({ length: 10 }, (_, c) => (r === 9 && c === 9 ? last : 'W')).join('&')).join('\\\\') +
  '\\end{matrix}';

describe('A. long words wrap in linear time', () => {
  it('a 64K-character zalgo word lays out in linear time', () => {
    const zalgo = ('a' + '\u0301\u0316\u0327'.repeat(10)).repeat(2000); // 31 code points × 2000 ≈ 62K
    expect(zalgo.length).toBeGreaterThan(60_000);
    layoutMarkdown('warm', 200, 16);
    expectLinear((n) => ('a' + '\u0301\u0316\u0327'.repeat(10)).repeat(n), 1000);
  });

  it('a 64K-character ZWJ chain lays out in linear time', () => {
    const chain = '👩\u200D'.repeat(21_000); // 3 code units each
    expect(chain.length).toBeGreaterThan(60_000);
    expectLinear((n) => '👩\u200D'.repeat(n), 10_500);
  });

  it('a long word in a code block too', () => {
    const word = 'x\u0301'.repeat(32_000);
    expect(word.length).toBe(64_000);
    expectLinear((n) => '```\n' + 'x\u0301'.repeat(n) + '\n```', 16_000);
  });

  it('clusters are bounded: extra combining marks are dropped, long emoji chains split', () => {
    const [first] = clusters('a' + '\u0301'.repeat(100));
    expect([...first!]).toHaveLength(1 + MAX_MARKS);
    expect(clusters('a' + '\u0301'.repeat(100) + 'b')).toEqual([first, 'b']);
    for (const c of clusters('👩\u200D'.repeat(100))) expect([...c].length).toBeLessThanOrEqual(MAX_CLUSTER);
    // Real sequences are untouched.
    expect(clusters('👩‍👩‍👧‍👦x')).toEqual(['👩‍👩‍👧‍👦', 'x']);
  });

  it('split pieces still fit the width', () => {
    for (const o of layoutMarkdown('é'.repeat(500), 120, 16).ops) if (o.k === 'text') expect(o.x + textWidth(o.text, o.font, o.size)).toBeLessThanOrEqual(120.01);
  });
});

describe('B. memory per box', () => {
  it('caps the total maths path of one box (the rest shows its source)', () => {
    const formulas = Array.from({ length: 10 }, (_, k) => '$' + grid(String.fromCharCode(97 + k)) + '$');
    const one = texToPath(grid('a'), false)!;
    expect(one.path.length).toBeGreaterThan(100_000);
    const n = paths(formulas.join('\n\n'));
    // 10 × ~166 KB would be ~1.7 MB: only what fits in 1 MB is drawn.
    expect(n).toBe(Math.floor(MATH_LIMITS.docPathChars / one.path.length));
  });

  it('the allowance counts path size', () => {
    const allow = mathAllowance();
    const big = { w: 1, a: 1, d: 0, path: 'M'.repeat(MATH_LIMITS.docPathChars - 10) };
    expect(allow.fits(big)).toBe(true);
    expect(allow.fits({ ...big, path: 'M'.repeat(20) })).toBe(false);
  });

  it('the layout cache is bounded by size as well as count', () => {
    const saved = { ...LAYOUT_CACHE };
    LAYOUT_CACHE.chars = 200_000;
    try {
      const text = '$' + grid('z') + '$';
      const big = layoutMarkdown(text, 400, 16);
      expect(layoutMarkdown(text, 400, 16)).toBe(big);
      // Another heavy box pushes it out (count alone wouldn't: 2 of 4000).
      layoutMarkdown('$' + grid('y') + '$', 400, 16);
      expect(layoutMarkdown(text, 400, 16)).not.toBe(big);
    } finally {
      Object.assign(LAYOUT_CACHE, saved);
    }
  });
});

describe('C. installing the same fallback fonts again keeps every cached layout', () => {
  afterEach(() => setFallbackTextMeasure(null));

  it('two canvases installing alternately (same fonts) don’t reset the cache', () => {
    const measureA = (t: string) => t.length * 7;
    const measureB = (t: string) => t.length * 7;
    setFallbackTextMeasure(measureA, 'Figtree+NotoSansMath');
    const epoch = textMetricsEpoch();
    const first = layoutMarkdown('Привет **мир** cache', 300, 16);
    for (let i = 0; i < 6; i++) {
      setFallbackTextMeasure(i % 2 ? measureA : measureB, 'Figtree+NotoSansMath');
      expect(layoutMarkdown('Привет **мир** cache', 300, 16)).toBe(first);
    }
    expect(textMetricsEpoch()).toBe(epoch);
    // Other fonts do redo layouts.
    setFallbackTextMeasure(measureA, 'other');
    expect(textMetricsEpoch()).toBe(epoch + 1);
  });
});

describe('E. the app’s time slice: maths never blocks for long, and fills in', () => {
  afterEach(() => setMathTimeSlice(null));

  it('defers maths past the slice, tells listeners after the task, and fills in on later renders', async () => {
    const text = Array.from({ length: 6 }, (_, k) => `$\\sqrt{${k}+slice_{${k}}}$`).join(' ');
    setMathTimeSlice(0);
    let told = 0;
    const off = onMathDeferred(() => told++);
    const epoch = mathDeferredEpoch();
    let n = paths(text);
    // The first new formula of a task always runs; the rest wait.
    expect(n).toBe(1);
    await tick();
    expect(told).toBe(1);
    expect(mathDeferredEpoch()).toBe(epoch + 1);
    for (let i = 0; i < 20 && n < 6; i++) {
      n = paths(text);
      await tick();
    }
    expect(n).toBe(6);
    off();
  });

  it('PDF export and layoutMarkdownSettled still get every formula', async () => {
    setMathTimeSlice(0);
    const text = Array.from({ length: 5 }, (_, k) => `$\\frac{${k}}{settled_${k}}$`).join(' ');
    const l = await layoutMarkdownSettled(text, 100_000, 16);
    expect(l.ops.filter((o) => o.k === 'path')).toHaveLength(5);
    const boxText = Array.from({ length: 5 }, (_, k) => `$\\sqrt{pdf_${k}}$`).join(' ');
    const page = new Page(new Y.Doc());
    page.addItem({ id: 'e', type: 'text', x: 40, y: 60, w: 300, text: boxText, fontSize: 16, color: '#000', format: 'md' });
    const pdf = await PDFDocument.load(await exportPdf(newNotebook(), async () => page, async () => new Uint8Array()));
    expect(pdf.getPageCount()).toBe(1);
    // The export rendered (and cached) every formula of the box.
    setMathTimeSlice(null);
    expect(paths(boxText, 300)).toBe(5);
  });
});

describe('G. a formula can’t be huge', () => {
  it('a formula over 50 em shows its source, so a box keeps a sane size', () => {
    expect(texToPath('\\rule{1pt}{100000em}', false)).toBeNull();
    expect(texToPath('\\rule{100000em}{1pt}', false)).toBeNull();
    const box: TextItem = { id: 't', type: 'text', x: 0, y: 0, w: 200, text: '$\\rule{1pt}{100000em}$', fontSize: 16, color: '#000', format: 'md' };
    const [, y0, , y1] = itemBBox(box);
    expect(y1 - y0).toBeLessThan(100);
  });
});

describe('previews show maths readably, not as TeX commands', () => {
  it('turns TeX into plain symbols', () => {
    expect(texToPlain('\\int_0^1 x^2\\,dx')).toBe('∫₀¹ x² dx');
    expect(texToPlain('v = \\sin x')).toBe('v = sin x');
    expect(texToPlain('\\frac{a+1}{b}')).toBe('(a+1)/b');
    expect(texToPlain('\\sqrt{2} \\cdot \\pi \\le \\alpha^{n}')).toBe('√2 · π ≤ αⁿ');
    expect(texToPlain('e^{i\\theta}')).toBe('e^(iθ)');
    expect(texToPlain('\\text{area} = \\left( r \\right)^2')).toBe('area = ( r )²');
    expect(texToPlain('\\unknown{x}')).toBe('unknownx');
  });

  it('comment previews and cards use it', () => {
    const plain = markdownToPlain('So $v = \\sin x$ and $$\\int_0^1 x^2\\,dx$$');
    expect(plain).toBe('So v = sin x and ∫₀¹ x² dx');
    expect(plain).not.toContain('\\');
  });
});

describe('zero-width characters', () => {
  it('take no room', () => {
    expect(textWidth('a\u200Bb', 'r', 16)).toBe(textWidth('ab', 'r', 16));
    expect(textWidth('\uFEFF', 'r', 16)).toBe(0);
  });

  it('draw nothing in a PDF (no ? for them)', async () => {
    const page = new Page(new Y.Doc());
    page.addItem({ id: 'z', type: 'text', x: 40, y: 60, w: 300, text: 'zero\u200Bwidth', fontSize: 16, color: '#000', format: 'md' });
    const pdf = await PDFDocument.load(await exportPdf(newNotebook(), async () => page, async () => new Uint8Array()));
    expect(pdf.getPageCount()).toBe(1);
  });
});

describe('F. indentation (laid out as written)', () => {
  it('keeps leading spaces at the start of a line and after a hard break, not after a wrap', () => {
    const ops = layoutMarkdown('&#32;   indented\n&#32; two', 400, 16).ops.filter((o) => o.k === 'text');
    expect(ops[0]!.k === 'text' && ops[0]!.text.startsWith('    indented')).toBe(true);
    expect(ops.some((o) => o.k === 'text' && o.text.startsWith('  two'))).toBe(true);
    // A wrapped line doesn't start with the space it broke at.
    for (const o of layoutMarkdown('word '.repeat(30), 100, 16).ops) if (o.k === 'text' && o.x === 0) expect(o.text.startsWith(' ')).toBe(false);
  });

  it('a tab is four spaces wide', () => {
    const tab = layoutMarkdown('&#9;x', 400, 16).ops.find((o) => o.k === 'text')!;
    expect(tab.k === 'text' && tab.text).toBe('    x');
  });
});
