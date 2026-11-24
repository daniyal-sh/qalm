import { layoutMarkdown, type MdFont, type TextItem } from '@qalm/core';
import * as React from 'react';
import { Skia, useTypeface, type SkCanvas, type SkFont, type SkPath, type SkPicture, type SkTypeface } from '@shopify/react-native-skia';

import figtree from '../assets/fonts/Figtree-Regular.ttf';
import figtreeBold from '../assets/fonts/Figtree-Bold.ttf';
import figtreeItalic from '../assets/fonts/Figtree-Italic.ttf';
import figtreeBoldItalic from '../assets/fonts/Figtree-BoldItalic.ttf';
import geistMono from '../assets/fonts/GeistMono-Regular.ttf';
import notoMath from '../assets/fonts/NotoSansMath-Subset.ttf';
import { disposeLater } from './dispose';

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
  if (!f) bySize.set(size, (f = Skia.Font(face, size)));
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
 * Draws a Markdown text box (`format: 'md'`) from core's layout: the same ops PDF export and agents' crops draw.
 * Text runs are placed by advance (`drawText`, as the layout measures), maths as outlines.
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
    if (op.k === 'text') c.drawText(op.text, op.x, op.y, paint, fontOf(faces[op.font], op.size));
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
