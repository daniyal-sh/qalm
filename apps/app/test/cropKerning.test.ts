import { markdownSvg, textWidth } from '@qalm/core';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Agents' crops (resvg) must place glyphs by their plain advances, as the layout measures them: no kerning, no
 * ligatures. A run drawn as one <text> is compared with the same glyphs drawn one by one at the layout's positions.
 */
const require = createRequire(import.meta.url);
const figtree = new Uint8Array(readFileSync(require.resolve('qalm-ink/package.json').replace('package.json', 'assets/fonts/Figtree-Regular.ttf')));
beforeAll(async () => {
  await initWasm(readFileSync(require.resolve('@resvg/resvg-wasm/index_bg.wasm'))).catch(() => undefined);
});

const W = 1400;
const H = 160;
const SIZE = 100;
const TEXT = 'AVATo fi';

function render(body: string): Uint8Array {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#fff"/>${body}</svg>`;
  const r = new Resvg(svg, { font: { fontBuffers: [figtree], defaultFontFamily: 'Figtree', loadSystemFonts: false }, background: '#ffffff' });
  const img = r.render();
  const px = img.pixels.slice();
  img.free();
  r.free();
  return px;
}

/** Share of pixels that differ noticeably between two renders. */
function diff(a: Uint8Array, b: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i]! - b[i]!) > 64) n++;
  return n / (a.length / 4);
}

/** The text drawn glyph by glyph at the layout's advances (nothing to kern or ligate). */
function oneByOne(): string {
  let x = 10;
  let out = '';
  for (const ch of TEXT) {
    if (ch !== ' ') out += `<text x="${x}" y="${10 + SIZE}" font-family="Figtree" font-size="${SIZE}" fill="#000">${ch}</text>`;
    x += textWidth(ch, 'r', SIZE);
  }
  return out;
}

describe('agents’ crops place glyphs as the layout measures them', () => {
  it('a Markdown run matches its glyphs drawn one by one (no kerning or ligatures)', () => {
    const md = markdownSvg({ x: 10, y: 10, w: W, text: TEXT, fontSize: SIZE }, '#000');
    expect(md).toContain('style="font-kerning:none;font-variant-ligatures:none"');
    const expected = render(oneByOne());
    expect(diff(render(md), expected)).toBeLessThan(0.002);
  });

  it('(the check bites: with kerning, as the attribute form left it, the run lands elsewhere)', () => {
    const kerned = markdownSvg({ x: 10, y: 10, w: W, text: TEXT, fontSize: SIZE }, '#000').replace(' style="font-kerning:none;font-variant-ligatures:none"', ' font-kerning="none"');
    expect(diff(render(kerned), render(oneByOne()))).toBeGreaterThan(0.005);
  });
});
