import { beforeAll, describe, expect, it } from 'vitest';
import { clusters, layoutMarkdown, loadMath, markdownToPlain, texToPath, texToPlain, MATH_LIMITS } from '../src';
import { transformPath, emptyBounds } from '../src/markdown/mathjax';

declare const performance: { now(): number };

// MathJax loads on demand: these tests render with it loaded.
beforeAll(() => loadMath());

const time = (fn: () => void) => {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
};

describe('the 50 em cap holds for what a formula paints, not just its box', () => {
  it('zero-size boxes with far-reaching paths show their source', () => {
    for (const tex of ['\\smash{\\rule{1pt}{1000em}}', '\\rlap{\\rule{1000em}{1pt}}', '\\llap{\\rule{1000em}{1pt}}', '\\hspace{-1000em}\\rule{1em}{1pt}', '\\smash{\\rule[-1000em]{1pt}{1pt}}']) {
      expect(texToPath(tex, false), tex).toBeNull();
      expect(layoutMarkdown(`see $${tex}$`, 4000, 16).ops.some((o) => o.k === 'text' && o.text.includes('rule'))).toBe(true);
    }
  });

  it('ordinary smashes, overlaps and spacing still render', () => {
    for (const tex of ['\\smash{x}', '\\rlap{/}=', '\\hspace{1em}\\rule{1em}{1pt}', '\\rule{10em}{1pt}', '\\sum_{i=1}^{n} \\frac{a}{b}']) expect(texToPath(tex, false), tex).not.toBeNull();
  });

  it('transformPath reports the bounds of everything it writes', () => {
    const b = emptyBounds();
    transformPath('M0 0L10 0Q20 30 0 5Z', [2, 1, 100, -1], b);
    expect(b).toEqual({ x0: 100, y0: -1, x1: 140, y1: 29 });
  });
});

describe('texToPlain (margin cards) is linear and safe on any input', () => {
  it('deep nesting within the cap: fast, and the same answer', () => {
    const depth = (MATH_LIMITS.texChars - 3) / 2; // `{`×n x `}`×n
    const deep = '{'.repeat(depth) + 'x^2' + '}'.repeat(depth);
    expect(deep.length).toBeLessThanOrEqual(MATH_LIMITS.texChars);
    expect(time(() => expect(texToPlain(deep)).toBe('x²'))).toBeLessThan(50);
    const fracs = '\\frac{'.repeat(80) + 'a' + '}{b}'.repeat(80);
    expect(fracs.length).toBeLessThanOrEqual(MATH_LIMITS.texChars);
    expect(texToPlain(fracs)).toMatch(/^\(+.*\/b$/);
  });

  it('past the cap (no formula renders there) it returns the TeX as it is, at once, whatever the nesting', () => {
    for (const tex of ['{'.repeat(20_000) + 'x' + '}'.repeat(20_000), '\\sqrt{'.repeat(7000) + 'x', 'x^'.repeat(20_000)]) {
      let out = '';
      expect(time(() => (out = texToPlain(tex)))).toBeLessThan(50);
      expect(out).toBe(tex);
    }
  });

  it('a 40K-character comment previews without throwing', () => {
    const big = `see $${'{'.repeat(20_000)}x${'}'.repeat(20_000)}$ and $\\alpha$`;
    expect(time(() => expect(markdownToPlain(big)).toContain('α'))).toBeLessThan(200);
  });
});

describe('Latin or Cyrillic mixed with CJK wraps in linear time', () => {
  it('`a中` repeated: twice the text takes at most ~2.5× as long', () => {
    let run = 0;
    const best = (text: string) => Math.min(...[0, 1, 2].map(() => time(() => layoutMarkdown(text, 200 + ++run / 100, 16))));
    const t1 = best('a中'.repeat(8000));
    const t2 = best('a中'.repeat(16_000));
    expect(t2).toBeLessThan(2.5 * t1 + 10);
    expect(t2).toBeLessThan(500);
  });

  it('a flag (two regional indicators) is one cluster', () => {
    expect(clusters('🇫🇷🇩🇪x')).toEqual(['🇫🇷', '🇩🇪', 'x']);
    expect(clusters('🇫🇷🇩')).toEqual(['🇫🇷', '🇩']);
    expect(clusters('a🇯🇵b')).toEqual(['a', '🇯🇵', 'b']);
  });
});
