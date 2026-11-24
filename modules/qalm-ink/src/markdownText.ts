import { layoutMarkdown, setFallbackTextMeasure, type MdFont, type TextItem } from '@qalm/core';
import * as React from 'react';
import {
  FontHinting,
  FontSlant,
  Skia,
  TextAlign,
  useTypeface,
  type SkCanvas,
  type SkFont,
  type SkParagraph,
  type SkPath,
  type SkPicture,
  type SkTypeface,
  type SkTypefaceFontProvider,
} from '@shopify/react-native-skia';

import figtree from '../assets/fonts/Figtree-Regular.ttf';
import figtreeBold from '../assets/fonts/Figtree-Bold.ttf';
import figtreeItalic from '../assets/fonts/Figtree-Italic.ttf';
import figtreeBoldItalic from '../assets/fonts/Figtree-BoldItalic.ttf';
import geistMono from '../assets/fonts/GeistMono-Regular.ttf';
import notoMath from '../assets/fonts/NotoSansMath-Subset.ttf';
import { disposeLater } from './dispose';
import { TEXT_FONTS } from './textMetrics';

/** The typefaces of Markdown text boxes, by core's font key (`MdFont`). */
export type MdTypefaces = Record<MdFont, SkTypeface>;

/**
 * Loads the Markdown fonts (Figtree regular/bold/italic/bold italic, Geist Mono, Noto Sans Math) once a page has a
 * Markdown text box (`needed`); null until all have loaded. Pages without one load nothing.
 */
export function useMdTypefaces(needed: boolean): MdTypefaces | null {
  const r = useTypeface(needed ? figtree : null);
  const b = useTypeface(needed ? figtreeBold : null);
  const i = useTypeface(needed ? figtreeItalic : null);
  const bi = useTypeface(needed ? figtreeBoldItalic : null);
  const m = useTypeface(needed ? geistMono : null);
  const x = useTypeface(needed ? notoMath : null);
  return React.useMemo(() => (r && b && i && bi && m && x ? { r, b, i, bi, m, x } : null), [r, b, i, bi, m, x]);
}

const fonts = new WeakMap<SkTypeface, Map<number, SkFont>>();
function fontOf(face: SkTypeface, size: number): SkFont {
  let bySize = fonts.get(face);
  if (!bySize) fonts.set(face, (bySize = new Map()));
  let f = bySize.get(size);
  if (!f) {
    f = Skia.Font(face, size);
    // Page units are scaled up on screen: hinted, whole-unit advances would make runs wider than the layout measured
    // (a bold word ran into the next). Linear, subpixel metrics match the fonts' real advances.
    f.setHinting(FontHinting.None);
    f.setLinearMetrics(true);
    f.setSubpixel(true);
    bySize.set(size, f);
  }
  return f;
}

const MAX_PATHS = 400;
const paths = new Map<string, SkPath | null>();
function pathOf(d: string): SkPath | null {
  if (paths.has(d)) return paths.get(d)!;
  const p = Skia.Path.MakeFromSVGString(d);
  if (paths.size >= MAX_PATHS) {
    const [k, old] = paths.entries().next().value!;
    paths.delete(k);
    if (old) disposeLater(old as unknown as { dispose?: () => void });
  }
  paths.set(d, p);
  return p;
}

/**
 * Text none of the Markdown fonts has (Cyrillic, CJK, emoji, …: core's fallback runs) is drawn and measured by a Skia
 * Paragraph, as plain text boxes are: with the text fonts, and on iOS and Android the system's fonts behind them (and
 * its shaping). Set once the text fonts have loaded; until then those runs are estimated and drawn as missing glyphs.
 */
let fallbackFonts: SkTypefaceFontProvider | null = null;
const MAX_WIDTHS = 4000;
const widths = new Map<string, number>();

function fallbackParagraph(text: string, font: MdFont, size: number, color: string, fonts: SkTypefaceFontProvider): SkParagraph {
  const bold = font === 'b' || font === 'bi';
  const italic = font === 'i' || font === 'bi';
  const p = Skia.ParagraphBuilder.Make({ textAlign: TextAlign.Left }, fonts)
    .pushStyle({ color: Skia.Color(color), fontFamilies: TEXT_FONTS, fontSize: size, fontStyle: { weight: bold ? 700 : 400, slant: italic ? FontSlant.Italic : FontSlant.Upright } })
    .addText(text)
    .pop()
    .build();
  p.layout(1e6);
  return p;
}

/** Installs Skia's measure for fallback runs into core's layout (after the text fonts load; layouts are redone). */
export function provideMarkdownFallback(fonts: SkTypefaceFontProvider): void {
  if (fallbackFonts === fonts) return;
  fallbackFonts = fonts;
  widths.clear();
  setFallbackTextMeasure((text, font, size) => {
    const key = `${font}|${size}|${text}`;
    let w = widths.get(key);
    if (w === undefined) {
      const p = fallbackParagraph(text, font, size, '#000000', fonts);
      w = p.getMaxIntrinsicWidth();
      (p as { dispose?: () => void }).dispose?.();
      if (widths.size >= MAX_WIDTHS) widths.delete(widths.keys().next().value!);
      widths.set(key, w);
    }
    return w;
  });
}

/**
 * Draws a Markdown text box (`format: 'md'`) from core's layout: the same ops PDF export and agents' crops draw.
 * Text runs are placed by advance (`drawText`, as the layout measures), fallback runs as Paragraphs, maths as outlines.
 */
export function drawMarkdownText(c: SkCanvas, item: TextItem, faces: MdTypefaces): void {
  const { ops } = layoutMarkdown(item.text, item.w, item.fontSize);
  const paint = Skia.Paint();
  paint.setAntiAlias(true);
  const color = Skia.Color(item.color);
  paint.setColor(color);
  c.save();
  c.translate(item.x, item.y);
  if (item.rot) c.rotate((item.rot * 180) / Math.PI, 0, 0);
  for (const op of ops) {
    if (op.k === 'text' && op.fallback && fallbackFonts) {
      // A fallback run: a Paragraph, its first baseline on the layout's.
      const p = fallbackParagraph(op.text, op.font, op.size, item.color, fallbackFonts);
      p.paint(c, op.x, op.y - (p.getLineMetrics()[0]?.baseline ?? op.size));
      disposeLater(p as unknown as { dispose?: () => void });
    } else if (op.k === 'text') c.drawText(op.text, op.x, op.y, paint, fontOf(faces[op.font], op.size));
    else if (op.k === 'rect') {
      paint.setAlphaf(op.alpha);
      c.drawRect(Skia.XYWHRect(op.x, op.y, op.w, op.h), paint);
      paint.setColor(color);
    } else {
      const p = pathOf(op.d);
      if (!p) continue;
      c.save();
      c.translate(op.x, op.y);
      c.scale(op.s, op.s);
      c.drawPath(p, paint);
      c.restore();
    }
  }
  c.restore();
  disposeLater(paint as unknown as { dispose?: () => void });
}

/** A Markdown text box recorded as a picture (PageCanvas's declarative tree draws it with `<Picture>`). */
export function markdownPicture(item: TextItem, faces: MdTypefaces): SkPicture {
  const rec = Skia.PictureRecorder();
  // Turned boxes reach out from their corner in any direction.
  const reach = Math.hypot(item.w, layoutMarkdown(item.text, item.w, item.fontSize).height) + item.fontSize;
  const c = rec.beginRecording(Skia.XYWHRect(item.x - reach, item.y - reach, reach * 2, reach * 2));
  drawMarkdownText(c, item, faces);
  return rec.finishRecordingAsPicture();
}
