import { initWasm, Resvg } from '@resvg/resvg-wasm';
import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm';
import figtree from '../assets/Figtree_500Medium.ttf';
import figtreeBold from '../assets/Figtree-Bold.ttf';
import figtreeItalic from '../assets/Figtree-Italic.ttf';
import figtreeBoldItalic from '../assets/Figtree-BoldItalic.ttf';
import geistMono from '../assets/GeistMono-Regular.ttf';
import notoMath from '../assets/NotoSansMath-Subset.ttf';

let ready: Promise<void> | null = null;
// Figtree for text; its bold and italics, Geist Mono and Noto Sans Math for Markdown text boxes (core's `markdownSvg`).
const fonts = [figtree, figtreeBold, figtreeItalic, figtreeBoldItalic, geistMono, notoMath].map((b) => new Uint8Array(b));

/** Renders an SVG (the Q-ink strip) to PNG with resvg. Text uses the bundled fonts. */
export async function svgToPng(svg: string): Promise<{ png: Uint8Array; width: number; height: number }> {
  ready ??= initWasm(resvgWasm);
  await ready;
  const r = new Resvg(svg, {
    font: { fontBuffers: fonts, defaultFontFamily: 'Figtree', monospaceFamily: 'Figtree', sansSerifFamily: 'Figtree' },
    background: '#ffffff',
  });
  try {
    const img = r.render();
    const out = { png: img.asPng(), width: img.width, height: img.height };
    img.free();
    return out;
  } finally {
    r.free();
  }
}
