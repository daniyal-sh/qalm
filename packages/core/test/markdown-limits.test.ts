import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { PDFDocument } from 'pdf-lib';
import {
  Page,
  allowedMath,
  clusters,
  exportPdf,
  fontRuns,
  layoutMarkdown,
  markdownToPlain,
  parseMarkdown,
  renderPageSvg,
  rendersMarkdown,
  setFallbackTextMeasure,
  texToPath,
  textHeight,
  textMetricsEpoch,
  textWidth,
  withMathBudget,
  loadMath,
  MATH_LIMITS,
  type TextItem,
} from '../src';
import { MATH_CACHE } from '../src/markdown/math';
import { newNotebook } from './helpers';

declare const performance: { now(): number };

// MathJax loads on demand (mathLazy.test.ts covers the limits before it has): these tests render with it loaded.
beforeAll(() => loadMath());

const box = (text: string, extra: Partial<TextItem> = {}): TextItem => ({ id: 't', type: 'text', x: 40, y: 60, w: 240, text, fontSize: 16, color: '#27272a', format: 'md', ...extra });
const paths = (text: string, w = 400) => layoutMarkdown(text, w, 16).ops.filter((o) => o.k === 'path').length;
const shownAsSource = (text: string, tex: string) => layoutMarkdown(text, 4000, 16).ops.some((o) => o.k === 'text' && o.text.includes(tex));
const info = { id: 'p', size: { w: 595, h: 842 }, paper: 'blank' as const, paperColor: 'white' as const, background: { kind: 'paper' as const } };
const pageSvg = (item: TextItem) => {
  const page = new Page(new Y.Doc());
  page.addItem(item);
  return renderPageSvg(info, page);
};

describe('maths limits (one box or comment can’t stall the app, a PDF export or the Worker)', () => {
  it('a formula over the length cap shows its source, at once', () => {
    const t0 = performance.now();
    expect(texToPath('x'.repeat(MATH_LIMITS.texChars + 1), false)).toBeNull();
    expect(performance.now() - t0).toBeLessThan(5);
    // Exactly at the cap (empty groups, so it stays small and narrow): rendered.
    const atCap = '{}'.repeat((MATH_LIMITS.texChars - 2) / 2) + 'yy';
    expect(atCap).toHaveLength(MATH_LIMITS.texChars);
    expect(texToPath(atCap, false)).not.toBeNull();
  });

  it('a formula whose outlines are too big shows its source', () => {
    // 1000 characters of x+x+… make ~500 KB of path.
    expect(texToPath('x+'.repeat(500), false)).toBeNull();
  });

  it('macro amplification is gone: definitions are undefined, so it costs nothing', () => {
    // The review's attack: each macro doubles the one before (here 18 levels, ~2^18 x's if it expanded).
    let tex = '\\def\\a{xx}';
    const names = 'bcdefghijklmnopqrs';
    for (let i = 0; i < names.length; i++) tex += `\\def\\${names[i]}{\\${i ? names[i - 1] : 'a'}\\${i ? names[i - 1] : 'a'}}`;
    tex += `\\${names[names.length - 1]}`;
    const t0 = performance.now();
    texToPath(tex, false);
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it('caps the formulas of one box: past the cap they show their source', () => {
    const many = Array.from({ length: MATH_LIMITS.perDoc + 10 }, (_, i) => `$x_{${i}}$`).join(' ');
    expect(paths(many, 4000)).toBe(MATH_LIMITS.perDoc);
    expect(shownAsSource(many, `x_{${MATH_LIMITS.perDoc + 5}}`)).toBe(true);
  });

  it('caps the TeX characters of one box', () => {
    // 895 characters each, mostly empty groups (small and narrow): 5 fit in 5000 characters, the 6th and 7th don't.
    const big = (k: number) => `$${'{}'.repeat(447)}${String.fromCharCode(97 + k)}$`;
    const text = Array.from({ length: 7 }, (_, k) => big(k)).join('\n\n');
    expect(paths(text, 100000)).toBe(5);
  });

  it('caps the formulas of a comment the same way', () => {
    const blocks = parseMarkdown(Array.from({ length: 40 }, (_, i) => `$y_{${i}}$`).join(' '));
    expect(allowedMath(blocks).size).toBe(MATH_LIMITS.perDoc);
  });

  it('a budget (the Worker’s crops) stops new maths once spent, and those layouts aren’t cached', () => {
    const text = '$budgeta+b$ and $budgetc+d$';
    const inBudget = withMathBudget({ chars: 10, ms: 60_000 }, () => layoutMarkdown(text, 400, 16));
    expect(inBudget.ops.filter((o) => o.k === 'path')).toHaveLength(1);
    // Outside the budget the same box renders both: the cut-short layout wasn't kept.
    expect(paths(text)).toBe(2);
    // Cached formulas are free under a budget.
    expect(withMathBudget({ chars: 0, ms: 60_000 }, () => paths(text))).toBe(2);
  });
});

describe('maths can’t leak between formulas (one MathJax for everyone)', () => {
  it('no definition outlives its formula: \\renewcommand, \\def, \\DeclareMathOperator', () => {
    // Fresh formulas (not cached) rendered before and after the attempts must match.
    const before = texToPath('\\frac{c}{d} ', false)!;
    const fooBefore = texToPath('\\foo ', false)!;
    texToPath('\\renewcommand{\\frac}[2]{Z}', false);
    texToPath('\\def\\frac#1#2{Z}', false);
    texToPath('\\DeclareMathOperator{\\frac}{Z}\\frac', false);
    texToPath('\\DeclareMathOperator{\\foo}{foo}\\foo', false);
    expect(texToPath('\\frac{c}{d}', false)!.path).toBe(before.path);
    expect(texToPath('\\foo', false)!.path).toBe(fooBefore.path);
  });

  it('labels reset between formulas (no "multiply defined" depending on order)', () => {
    expect(texToPath('x \\label{eq}', true)).not.toBeNull();
    expect(texToPath('y \\label{eq}', true)).not.toBeNull();
  });

  it('a formula that blows MathJax’s stack fails alone', () => {
    const before = texToPath('\\sqrt{a} ', false)!;
    expect(texToPath('x_{'.repeat(250) + 'y' + '}'.repeat(250), false)).toBeNull();
    expect(texToPath('\\sqrt{a}', false)!.path).toBe(before.path);
  });
});

describe('raw HTML shows as the text it is', () => {
  it('keeps ordinary text with < and > (it used to vanish)', () => {
    expect(markdownToPlain('if 0<x and y>1 then')).toBe('if 0<x and y>1 then');
    expect(markdownToPlain('List<T> and <b>hi</b>')).toBe('List<T> and <b>hi</b>');
  });

  it('a <pre> or <!-- line hides nothing after it', () => {
    expect(markdownToPlain('<pre>\nkept\n\nstill here')).toBe('<pre>\nkept\nstill here');
    expect(markdownToPlain('<!-- note\n\nrest')).toBe('<!-- note\nrest');
  });

  it('tags are text, never markup', () => {
    expect(parseMarkdown('<div onclick="x()">a</div>')).toEqual([{ t: 'p', c: [{ t: 'text', text: '<div onclick="x()">a</div>', m: {} }] }]);
    expect(pageSvg(box('<b>x</b>'))).toContain('&lt;b&gt;x&lt;/b&gt;');
  });

  it('autolinks still work', () => {
    const [p] = parseMarkdown('<https://a.b>');
    expect(p).toEqual({ t: 'p', c: [{ t: 'text', text: 'https://a.b', m: { href: 'https://a.b' } }] });
  });
});

describe('text the bundled fonts lack (Cyrillic, Arabic, CJK, emoji)', () => {
  afterEach(() => setFallbackTextMeasure(null));

  it('Cyrillic, CJK and emoji are fallback runs, keeping their style', () => {
    expect(fontRuns('Привет мир', 'b')).toEqual([
      { font: 'b', text: 'Привет', fallback: true },
      { font: 'b', text: ' ' },
      { font: 'b', text: 'мир', fallback: true },
    ]);
    expect(fontRuns('漢字', 'r')).toEqual([{ font: 'r', text: '漢字', fallback: true }]);
    const ops = layoutMarkdown('**Привет** 漢字 😀', 400, 16).ops.filter((o) => o.k === 'text');
    expect(ops.find((o) => o.k === 'text' && o.text === 'Привет')).toMatchObject({ font: 'b', fallback: true });
    expect(ops.some((o) => o.k === 'text' && o.text.includes('😀') && o.fallback)).toBe(true);
  });

  it('never splits an emoji sequence or a letter from its accent', () => {
    expect(clusters('a👩‍💻b')).toEqual(['a', '👩‍💻', 'b']);
    expect(clusters('👍🏽!')).toEqual(['👍🏽', '!']);
    expect(clusters('éx')).toEqual(['é', 'x']);
    expect(clusters('❤️')).toEqual(['❤️']);
    expect(fontRuns('a👩‍💻b', 'r')).toEqual([{ font: 'r', text: 'a' }, { font: 'r', text: '👩‍💻', fallback: true }, { font: 'r', text: 'b' }]);
  });

  it('CJK wraps between characters', () => {
    const l = layoutMarkdown('漢字'.repeat(30), 100, 16);
    const texts = l.ops.filter((o) => o.k === 'text');
    expect(new Set(texts.map((o) => o.y)).size).toBeGreaterThan(5);
    for (const o of texts) if (o.k === 'text') expect(o.x + textWidth(o.text, o.font, o.size)).toBeLessThanOrEqual(100.01);
  });

  it('the app’s measure (a Skia Paragraph) replaces the estimate, and layouts are redone', () => {
    const before = layoutMarkdown('Привет **мир**', 400, 16);
    const epoch = textMetricsEpoch();
    setFallbackTextMeasure((text) => text.length * 7);
    expect(textMetricsEpoch()).toBe(epoch + 1);
    expect(textWidth('Привет', 'r', 16)).toBe(42);
    const after = layoutMarkdown('Привет **мир**', 400, 16);
    expect(after).not.toBe(before);
    expect(after.ops.find((o) => o.k === 'text' && o.text === 'мир')).toMatchObject({ x: 42 + textWidth(' ', 'r', 16) });
  });

  it('a box with Arabic or Hebrew draws as plain text everywhere (the layout can’t order right-to-left)', () => {
    const ar = box('مرحبا **بالعالم**');
    const he = box('שלום *עולם*');
    expect(rendersMarkdown(ar)).toBe(false);
    expect(rendersMarkdown(he)).toBe(false);
    expect(rendersMarkdown(box('Привет **мир** 漢字 😀'))).toBe(true);
    const plain = { ...ar, format: undefined };
    expect(textHeight(ar)).toBe(textHeight(plain));
    expect(pageSvg(ar)).toBe(pageSvg(plain));
    expect(pageSvg(ar)).toContain('**بالعالم**');
  });

  it('PDF export draws them as plain boxes do (? for what no font has), without failing', async () => {
    const page = new Page(new Y.Doc());
    page.addItem(box('Привет **мир** 漢字 😀 and مرحبا in another', { id: 'a' }));
    page.addItem(box('**Привет** 漢字 😀', { id: 'b', y: 300 }));
    const pdf = await PDFDocument.load(await exportPdf(newNotebook(), async () => page, async () => new Uint8Array()));
    expect(pdf.getPageCount()).toBe(1);
  });

  it('agents’ crops keep the text for resvg', () => {
    expect(pageSvg(box('Привет **мир**'))).toContain('>Привет</text>');
  });
});

describe('caches', () => {
  it('a second pass over 1000 boxes hits the layout cache', () => {
    const texts = Array.from({ length: 1000 }, (_, i) => `box **${i}**`);
    const first = texts.map((t) => layoutMarkdown(t, 200, 16));
    const second = texts.map((t) => layoutMarkdown(t, 200, 16));
    expect(second.every((l, i) => l === first[i])).toBe(true);
  });

  it('the maths cache keeps what’s used (LRU), and forgets the rest', () => {
    const saved = { ...MATH_CACHE };
    MATH_CACHE.count = 5;
    try {
      const a = texToPath('lru_a', false);
      const b = texToPath('lru_b', false);
      for (let i = 0; i < 8; i++) {
        texToPath(`lru_${i}`, false);
        expect(texToPath('lru_a', false)).toBe(a); // used: kept
      }
      expect(texToPath('lru_b', false)).not.toBe(b); // not used since: re-rendered
    } finally {
      Object.assign(MATH_CACHE, saved);
    }
  });
});

describe('agents’ crops place glyphs by advance', () => {
  it('turns off kerning and ligatures for Markdown text', () => {
    const svg = pageSvg(box('office AV'));
    expect(svg).toContain('style="font-kerning:none;font-variant-ligatures:none"');
  });
});
