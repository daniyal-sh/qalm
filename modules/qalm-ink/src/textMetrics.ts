import { setTextMeasure, TEXT_LINE_HEIGHT, type TextItem } from '@qalm/core';
import { Skia, TextAlign, type SkParagraph, type SkTypefaceFontProvider } from '@shopify/react-native-skia';

/**
 * Text boxes' fonts, in fallback order: Figtree, then a subset of Noto Sans Math (OFL; Greek, operators, arrows,
 * super/subscripts) for what Figtree lacks, so ∫ √ π αβγ draw instead of empty boxes. PageCanvas loads both.
 */
export const TEXT_FONTS = ['Figtree', 'NotoSansMath'];

type TextLayout = Pick<TextItem, 'text' | 'w' | 'fontSize'> & { color?: string };

/** The paragraph PageCanvas draws for a text box (`TEXT_FONTS`, TEXT_LINE_HEIGHT), laid out at the box's width. */
export function textParagraph(item: TextLayout, fonts: SkTypefaceFontProvider): SkParagraph {
  const p = Skia.ParagraphBuilder.Make({ textAlign: TextAlign.Left }, fonts)
    .pushStyle({ color: Skia.Color(item.color ?? '#000000'), fontFamilies: TEXT_FONTS, fontSize: item.fontSize, heightMultiplier: TEXT_LINE_HEIGHT })
    .addText(item.text || ' ')
    .pop()
    .build();
  p.layout(item.w);
  return p;
}

const MAX_CACHED = 500;
const cache = new Map<string, number>();
let provider: SkTypefaceFontProvider | null = null;

/** The laid-out height of a text box with the real font (cached by text, width and size). */
function measureText(item: Pick<TextItem, 'text' | 'w' | 'fontSize'>): number | null {
  if (!provider) return null;
  const key = `${item.fontSize}|${Math.round(item.w * 100)}|${item.text}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const p = textParagraph(item, provider);
  const h = p.getHeight();
  (p as { dispose?: () => void }).dispose?.();
  if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value!);
  cache.set(key, h);
  return h;
}

/** Called once the canvas's fonts have loaded: text heights are measured from then on (core's `textHeight`). */
export function provideTextFonts(fonts: SkTypefaceFontProvider): void {
  // Every page canvas loads its own provider of the same fonts: keep the first, so the cache survives page switches.
  if (provider) return;
  provider = fonts;
  cache.clear();
  setTextMeasure(measureText);
}
