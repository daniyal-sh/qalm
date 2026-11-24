import { beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { Page, exportPdf, itemBBox, layoutMarkdown, loadMath, markdownToPlain, parseMarkdown, renderPageSvg, safeHref, texToPath, textHeight, textWidth, fontRuns, type TextItem } from '../src';
import { renderRegionsSvg } from '../src/render/regions';
import { transformPath } from '../src/markdown/mathjax';
import { FONT_ADVANCES } from '../src/markdown/fontMetrics';
import { FONT_B_B64, FONT_BI_B64, FONT_I_B64, FONT_M_B64, FONT_X_B64 } from '../src/markdown/fontData';
import { newNotebook } from './helpers';

declare const process: { getBuiltinModule(m: 'node:fs'): { readFileSync(path: string): Uint8Array } };
declare const Buffer: { from(s: string, enc: 'base64'): Uint8Array };

const box = (text: string, extra: Partial<TextItem> = {}): TextItem => ({ id: 't', type: 'text', x: 40, y: 60, w: 240, text, fontSize: 16, color: '#27272a', format: 'md', ...extra });

// MathJax loads on demand (mathLazy.test.ts covers before it has): these tests lay maths out with it loaded.
beforeAll(() => loadMath());

describe('parseMarkdown', () => {
  it('reads the supported syntax', () => {
    const [p] = parseMarkdown('**b** *i* ~~s~~ `c` [l](https://a.b) $x^2$');
    expect(p).toEqual({
      t: 'p',
      c: [
        { t: 'text', text: 'b', m: { b: true } },
        { t: 'text', text: ' ', m: {} },
        { t: 'text', text: 'i', m: { i: true } },
        { t: 'text', text: ' ', m: {} },
        { t: 'text', text: 's', m: { s: true } },
        { t: 'text', text: ' ', m: {} },
        { t: 'text', text: 'c', m: { code: true } },
        { t: 'text', text: ' ', m: {} },
        { t: 'text', text: 'l', m: { href: 'https://a.b' } },
        { t: 'text', text: ' ', m: {} },
        { t: 'math', tex: 'x^2', m: {} },
      ],
    });
    const kinds = parseMarkdown('# H\n\n- a\n- b\n\n1. c\n\n> q\n\n```\ncode\n```\n\n$$\n\\int x\n$$\n\n---').map((b) => b.t);
    expect(kinds).toEqual(['h', 'list', 'list', 'quote', 'code', 'math', 'hr']);
  });

  it('keeps a single newline as a line break, as typed in a note', () => {
    expect(parseMarkdown('one\ntwo')[0]).toEqual({ t: 'p', c: [{ t: 'text', text: 'one', m: {} }, { t: 'br' }, { t: 'text', text: 'two', m: {} }] });
  });

  it('never renders raw HTML: it is plain text (more in markdown-limits.test.ts)', () => {
    expect(markdownToPlain('<b>hi</b> <img src=x onerror=alert(1)> there')).toBe('<b>hi</b> <img src=x onerror=alert(1)> there');
    const all = parseMarkdown('<script>\nalert(1)\n</script>\n\n<iframe src="https://evil">');
    expect(all.every((b) => b.t === 'p' && b.c.every((x) => x.t !== 'math' && (x.t === 'br' || !x.m.href)))).toBe(true);
  });

  it('only links http, https and mailto, and never fetches images', () => {
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref(' JavaScript:alert(1)')).toBeNull();
    expect(safeHref('data:text/html,x')).toBeNull();
    expect(safeHref('mailto:a@b.c')).toBe('mailto:a@b.c');
    const marks = (src: string) => parseMarkdown(src).flatMap((b) => (b.t === 'p' ? b.c : [])).map((x) => (x.t === 'br' ? null : x.m.href));
    expect(marks('[x](javascript:alert(1))')).not.toContain('javascript:alert(1)');
    expect(marks('[x](vbscript:msgbox)').filter(Boolean)).toEqual([]);
    expect(marks('<https://a.b>')).toEqual(['https://a.b']);
    expect(markdownToPlain('![a cat](https://tracker.example/pixel.png)')).toBe('a cat');
  });

  it('reads $ maths but leaves prices alone', () => {
    const maths = (src: string) => parseMarkdown(src).flatMap((b) => (b.t === 'p' ? b.c : [])).filter((x) => x.t === 'math');
    expect(maths('costs $5 and $6')).toEqual([]);
    expect(maths('a $ x $ b')).toEqual([]);
    expect(maths('escaped \\$x$')).toEqual([]);
    expect(maths('inline $$a+b$$ too')).toHaveLength(1);
    expect(maths('`$x$` is code')).toEqual([]);
    expect(parseMarkdown('$$\\frac{a}{b}$$')).toEqual([{ t: 'math', tex: '\\frac{a}{b}' }]);
    // TeX is kept raw: Markdown escapes (`\,` `\{` `\*`) don't apply inside maths.
    expect(maths('area $\\int_0^1 x^2\\,dx \\{a\\} a\\*b$')).toEqual([{ t: 'math', tex: '\\int_0^1 x^2\\,dx \\{a\\} a\\*b', m: {} }]);
  });

  it('gives comment previews their plain text', () => {
    expect(markdownToPlain('**Nice** work: $x^2$\n\n- one\n- two')).toBe('Nice work: x²\n• one\n• two');
  });
});

describe('maths', () => {
  it('turns TeX into one absolute path with its size', () => {
    const b = texToPath('\\frac{a}{b}', false)!;
    expect(b.w).toBeGreaterThan(0.3);
    expect(b.a).toBeGreaterThan(0.5);
    expect(b.d).toBeGreaterThan(0.2);
    expect(b.path).toMatch(/^M/);
    expect(b.path).not.toMatch(/[a-z]/);
  });

  it('gives up on TeX errors (the source is shown instead)', () => {
    expect(texToPath('\\frac{1}{', false)).toBeNull();
    const l = layoutMarkdown('$\\frac{1}{$', 300, 16);
    expect(l.ops.some((o) => o.k === 'text' && o.text.includes('frac'))).toBe(true);
  });

  it('flattens relative and shorthand path commands', () => {
    expect(transformPath('m1 2l3 4h5v6z', [2, -1, 10, 0])).toBe('M12 -2L18 -6L28 -6L28 -12Z');
    expect(transformPath('M0 0Q1 1 2 0T4 0', [1, 1, 0, 0])).toBe('M0 0Q1 1 2 0Q3 -1 4 0');
  });
});

describe('layoutMarkdown', () => {
  it('wraps inside the box width', () => {
    const l = layoutMarkdown('word '.repeat(40), 120, 16);
    for (const op of l.ops) if (op.k === 'text') expect(op.x + textWidth(op.text, op.font, op.size)).toBeLessThanOrEqual(120.01);
    expect(l.height).toBeGreaterThan(16 * 1.3 * 5);
  });

  it('splits a word wider than the box', () => {
    const l = layoutMarkdown('x'.repeat(80), 100, 16);
    expect(new Set(l.ops.map((o) => o.y)).size).toBeGreaterThan(3);
  });

  it('draws marks as fonts and rules', () => {
    const fonts = layoutMarkdown('**b** *i* ***bi*** `m`', 400, 16).ops.flatMap((o) => (o.k === 'text' ? [o.font] : []));
    expect(fonts).toEqual(expect.arrayContaining(['b', 'i', 'bi', 'm']));
    // Strike-through and link underline are rules in the text colour.
    expect(layoutMarkdown('~~gone~~', 400, 16).ops.some((o) => o.k === 'rect' && o.alpha === 1)).toBe(true);
    expect(layoutMarkdown('[l](https://a.b)', 400, 16).ops.some((o) => o.k === 'rect' && o.alpha === 1)).toBe(true);
  });

  it('draws maths as paths, and Greek with the maths font', () => {
    expect(layoutMarkdown('$x^2$ and $$\\sum_i i$$', 300, 16).ops.filter((o) => o.k === 'path')).toHaveLength(2);
    expect(fontRuns('a ≤ αβ', 'r')).toEqual([
      { font: 'r', text: 'a ≤ ' },
      { font: 'x', text: 'αβ' },
    ]);
  });

  it('shrinks display maths too wide for the box', () => {
    const l = layoutMarkdown('$$a+b+c+d+e+f+g+h+i+j+k+l+m+n+o+p$$', 80, 16);
    const p = l.ops.find((o) => o.k === 'path')!;
    expect(p.k === 'path' && p.x).toBeGreaterThanOrEqual(0);
    expect(p.k === 'path' && p.s).toBeLessThan((16 * 1.15) / 1000);
  });

  it('is as tall as its blocks, so frames and hit boxes fit', () => {
    const one = textHeight(box('one line'));
    expect(one).toBeCloseTo(16 * 1.3);
    expect(textHeight(box('# Title\n\nbody\n\n- a\n- b'))).toBeGreaterThan(one * 4);
    const b = itemBBox(box('# Title\n\nbody'));
    expect(b[3] - b[1]).toBeCloseTo(textHeight(box('# Title\n\nbody')));
  });
});

describe('old text boxes stay plain text', () => {
  const old: TextItem = { id: 'o', type: 'text', x: 40, y: 60, w: 240, text: 'price *5* each\n# not a heading', fontSize: 16, color: '#27272a' };

  it('keeps their height and SVG exactly as before', () => {
    expect(textHeight(old)).toBe(2 * 16 * 1.3);
    const page = new Page(new Y.Doc());
    page.addItem(old);
    const svg = renderPageSvg({ id: 'p', size: { w: 595, h: 842 }, paper: 'blank', paperColor: 'white', background: { kind: 'paper' } }, page);
    expect(svg).toContain('>price *5* each</tspan>');
    expect(svg).toContain('># not a heading</tspan>');
    expect(svg).not.toContain('font-weight');
  });

  it('renders the same text formatted once it has the flag', () => {
    const page = new Page(new Y.Doc());
    page.addItem({ ...old, format: 'md' });
    const svg = renderPageSvg({ id: 'p', size: { w: 595, h: 842 }, paper: 'blank', paperColor: 'white', background: { kind: 'paper' } }, page);
    expect(svg).toContain('font-style="italic"');
    expect(svg).toContain('font-weight="700"');
    expect(svg).not.toContain('*5*');
  });

  it('the flag syncs through the page doc, and clearing it makes the box plain again', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.on('update', (u: Uint8Array) => Y.applyUpdate(b, u));
    const pa = new Page(a);
    pa.addItem(old);
    expect(new Page(b).item('o')).not.toHaveProperty('format');
    pa.updateItem('o', { format: 'md' } as Partial<TextItem>);
    expect(new Page(b).item('o')).toMatchObject({ format: 'md' });
    pa.updateItem('o', { format: undefined } as Partial<TextItem>);
    expect(new Page(b).item('o')).not.toHaveProperty('format');
  });
});

describe('Markdown in exports and agents’ crops', () => {
  const fontsOf = (doc: PDFDocument) =>
    doc.context
      .enumerateIndirectObjects()
      .map(([, o]) => o)
      .filter((o): o is PDFDict => o instanceof PDFDict && o.get(PDFName.of('Type')) === PDFName.of('Font'))
      .map((d) => String(d.get(PDFName.of('BaseFont'))))
      .filter((n) => n !== 'undefined');

  it('PDF export embeds the fonts the box uses, and draws maths as paths', async () => {
    const page = new Page(new Y.Doc());
    page.addItem(box('**Bold** *it* `code` α $\\sqrt{2}$', { rot: 0.3 }));
    const out = await PDFDocument.load(await exportPdf(newNotebook(), async () => page, async () => new Uint8Array()));
    const fonts = fontsOf(out);
    for (const f of ['Figtree-Regular', 'Figtree-Bold', 'Figtree-Italic', 'GeistMono-Regular', 'NotoSansMath']) expect(fonts.some((n) => n.includes(f))).toBe(true);
    expect(fonts.some((n) => n.includes('BoldItalic'))).toBe(false);
  });

  it('agents’ crops draw a Markdown box in the crop’s ink', () => {
    const page = new Page(new Y.Doc());
    page.addItem(box('**hi** $x$'));
    const { svg } = renderRegionsSvg({ p: page }, [{ pageId: 'p', label: '[1]', box: [30, 50, 300, 100], fresh: [], context: [], erased: [], clip: true, unit: 20 }]);
    expect(svg).toContain('font-weight="700"');
    expect(svg).toContain('fill="#000000"');
    expect(svg).not.toContain('#27272a');
  });
});

describe('Markdown font data', () => {
  const fs = process.getBuiltinModule('node:fs');
  const files: Record<string, string> = { b: 'Figtree-Bold', i: 'Figtree-Italic', bi: 'Figtree-BoldItalic', m: 'GeistMono-Regular', x: 'NotoSansMath-Subset' };
  const b64: Record<string, string> = { b: FONT_B_B64, i: FONT_I_B64, bi: FONT_BI_B64, m: FONT_M_B64, x: FONT_X_B64 };

  it('is generated from the fonts the app draws with (run scripts/gen-md-fonts.mjs after changing them)', () => {
    for (const [k, name] of Object.entries({ r: 'Figtree-Regular', ...files })) {
      const ttf = fs.readFileSync(`../../modules/qalm-ink/assets/fonts/${name}.ttf`);
      if (k !== 'r') expect(new Uint8Array(Buffer.from(b64[k]!, 'base64'))).toEqual(new Uint8Array(ttf));
      const font = fontkit.create(ttf as never) as unknown as { unitsPerEm: number; glyphForCodePoint(cp: number): { advanceWidth: number } };
      const [first, ...advs] = FONT_ADVANCES[k]![0]!;
      expect(advs[0]).toBe(Math.round((font.glyphForCodePoint(first!).advanceWidth * 1000) / font.unitsPerEm));
    }
  });
});
