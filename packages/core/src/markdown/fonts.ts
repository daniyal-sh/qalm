import { FONT_ADVANCES } from './fontMetrics';

/**
 * The fonts of Markdown text boxes: Figtree regular, bold, italic and bold italic, Geist Mono for code, and Noto Sans
 * Math (subset) for maths symbols and Greek Figtree lacks. Every renderer draws with these files (qalm-ink's assets),
 * and the layout measures them with their real advance widths (`fontMetrics.ts`), so a box wraps the same on the page,
 * in PDF exports and in agents' crops.
 *
 * Text none of them has (Cyrillic, CJK, emoji, Devanagari, …) is a **fallback run**: on the page it's drawn and measured
 * by a Skia Paragraph like a plain box (the app installs `setFallbackTextMeasure`; native falls back to system fonts),
 * elsewhere it's estimated and drawn as plain boxes draw it (PDF: `?`).
 */
export type MdFont = 'r' | 'b' | 'i' | 'bi' | 'm' | 'x';
export const MD_FONTS: readonly MdFont[] = ['r', 'b', 'i', 'bi', 'm', 'x'];

/** A piece of text drawn in one font; `fallback`: no bundled font has it (drawn in `font`'s style by a fallback). */
export interface FontRun {
  font: MdFont;
  text: string;
  fallback?: true;
}

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

/** Code points that belong to the character before them: combining marks, joiners, variation selectors, skin tones, tags. */
const ATTACHES = /^[\p{M}\u200D\uFE00-\uFE0F\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]$/u;
const ZWJ = 0x200d;

/** Splits text into rough grapheme clusters (never between a character and its marks, or inside an emoji sequence). */
export function clusters(text: string): string[] {
  const out: string[] = [];
  let prevZwj = false;
  for (const ch of text) {
    if (out.length && (prevZwj || ATTACHES.test(ch))) out[out.length - 1] += ch;
    else out.push(ch);
    prevZwj = ch.codePointAt(0) === ZWJ;
  }
  return out;
}

/** Measures fallback runs (the app installs Skia's); null = estimate. */
export type FallbackMeasure = (text: string, font: MdFont, size: number) => number;
let fallbackMeasure: FallbackMeasure | null = null;
let epoch = 0;

/** Installs how fallback runs are measured (the app: a Skia Paragraph, as it draws them). Layouts made before are redone. */
export function setFallbackTextMeasure(fn: FallbackMeasure | null): void {
  fallbackMeasure = fn;
  epoch++;
}

/** Changes whenever text measuring changes (part of the layout cache key). */
export const textMetricsEpoch = (): number => epoch;

/** Per 1000 em, for text no bundled font has: wide for CJK and emoji, else an average glyph. */
function estimate(text: string, size: number): number {
  let w = 0;
  for (const c of clusters(text)) w += c.codePointAt(0)! >= 0x2e80 ? 1000 : 600;
  return (w * size) / 1000;
}

/**
 * Splits text in `font` into runs each drawn with one font: characters the font lacks use the maths font when it has
 * them (∫ √ ≤ α …), else they're a fallback run in `font`'s style.
 */
export function fontRuns(text: string, font: MdFont): FontRun[] {
  const runs: FontRun[] = [];
  for (const c of clusters(text)) {
    const cp = c.codePointAt(0)!;
    const f: MdFont = fontHas(font, cp) ? font : font !== 'x' && fontHas('x', cp) ? 'x' : font;
    const fallback = !fontHas(f, cp);
    const last = runs[runs.length - 1];
    if (last && last.font === f && !!last.fallback === fallback) last.text += c;
    else runs.push(fallback ? { font: f, text: c, fallback: true } : { font: f, text: c });
  }
  return runs;
}

/** Width of `text` in `font` at `size` (no kerning: Skia's drawText, pdf-lib and our layout all place glyphs by advance). */
export function textWidth(text: string, font: MdFont, size: number): number {
  let w = 0;
  for (const r of fontRuns(text, font)) {
    if (r.fallback) w += fallbackMeasure?.(r.text, r.font, size) ?? estimate(r.text, size);
    else {
      const t = advances()[r.font];
      let units = 0;
      for (const ch of r.text) units += t.get(ch.codePointAt(0)!) ?? 0;
      w += (units * size) / 1000;
    }
  }
  return w;
}

/** Right-to-left scripts (Hebrew, Arabic, Syriac, Thaana, N'Ko, …): the Markdown layout can't order them. */
const RTL = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;
export const hasRtl = (text: string): boolean => RTL.test(text);
