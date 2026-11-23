import { initWasm, Resvg } from '@resvg/resvg-wasm';
import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm';
import figtree from '../assets/Figtree_500Medium.ttf';

let ready: Promise<void> | null = null;
const font = new Uint8Array(figtree);

/** Renders an SVG (the Q-ink strip) to PNG with resvg. Text uses the bundled Figtree. */
export async function svgToPng(svg: string): Promise<{ png: Uint8Array; width: number; height: number }> {
  ready ??= initWasm(resvgWasm);
  await ready;
  const r = new Resvg(svg, {
    font: { fontBuffers: [font], defaultFontFamily: 'Figtree', monospaceFamily: 'Figtree', sansSerifFamily: 'Figtree' },
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
