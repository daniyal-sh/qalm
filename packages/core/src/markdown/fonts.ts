import { FONT_ADVANCES } from './fontMetrics';

/**
 * The fonts of Markdown text boxes: Figtree regular, bold, italic and bold italic, Geist Mono for code, and Noto Sans
 * Math (subset) for maths symbols and Greek Figtree lacks. Every renderer draws with these files (qalm-ink's assets),
 * and the layout measures them with their real advance widths (`fontMetrics.ts`), so a box wraps the same on the page,
 * in PDF exports and in agents' crops.
 */
export type MdFont = 'r' | 'b' | 'i' | 'bi' | 'm' | 'x';
export const MD_FONTS: readonly MdFont[] = ['r', 'b', 'i', 'bi', 'm', 'x'];

/** Advance of a character no font has (it draws as a missing-glyph box), per 1000 em. */
const MISSING = 600;

let tables: Record<MdFont, Map<number, number>> | null = null;
function advances(): Record<MdFont, Map<number, number>> {
  if (tables) return tables;
  const t = {} as Record<MdFont, Map<number, number>>;
  for (const f of MD_FONTS) {
    const m = new Map<number, number>();
    for (const [first, ...advs] of FONT_ADVANCES[f] ?? []) advs.forEach((a, k) => m.set(first! + k, a));
    t[f] = m;
  }
  return (tables = t);
}

/** Does the font have a glyph for the code point? */
export function fontHas(font: MdFont, cp: number): boolean {
  return advances()[font].has(cp);
}

/** Width of `text` in `font` at `size` (no kerning: Skia's drawText, pdf-lib and our layout all place glyphs by advance). */
export function textWidth(text: string, font: MdFont, size: number): number {
  const t = advances()[font];
  let w = 0;
  for (const ch of text) w += t.get(ch.codePointAt(0)!) ?? MISSING;
  return (w * size) / 1000;
}

/**
 * Splits text in `font` into runs each drawn with one font: characters the font lacks use the maths font when it has
 * them (∫ √ ≤ α …), else stay in `font` (drawn as missing-glyph boxes, as on screen).
 */
export function fontRuns(text: string, font: MdFont): { font: MdFont; text: string }[] {
  const runs: { font: MdFont; text: string }[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const f = font !== 'x' && !fontHas(font, cp) && fontHas('x', cp) ? 'x' : font;
    const last = runs[runs.length - 1];
    if (last?.font === f) last.text += ch;
    else runs.push({ font: f, text: ch });
  }
  return runs;
}
