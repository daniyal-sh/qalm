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
const MARK = /^\p{M}$/u;
const ZWJ = 0x200d;
/** Regional indicators: a pair of them is one flag (🇫🇷). */
const isRegional = (cp: number) => cp >= 0x1f1e6 && cp <= 0x1f1ff;
/** Combining marks kept per character: "zalgo" text stacks hundreds, which would all land on one spot anyway. */
export const MAX_MARKS = 8;
/** Code points per cluster: a longer emoji (ZWJ) sequence starts a new cluster rather than growing one forever. */
export const MAX_CLUSTER = 32;

/**
 * Splits text into rough grapheme clusters (never between a character and its marks, inside an emoji sequence, or
 * between the two halves of a flag), dropping combining marks past `MAX_MARKS` on one character. Linear in the text:
 * each cluster is bounded.
 */
export function clusters(text: string): string[] {
  const out: string[] = [];
  let prevZwj = false;
  let size = 0;
  let marks = 0;
  /** The last cluster is one regional indicator, waiting for its pair. */
  let halfFlag = false;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (isRegional(cp)) {
      if (halfFlag) {
        out[out.length - 1] += ch;
        size++;
        halfFlag = false;
        prevZwj = false;
        continue;
      }
      out.push(ch);
      size = 1;
      marks = 0;
      prevZwj = false;
      halfFlag = true;
      continue;
    }
    halfFlag = false;
    const mark = MARK.test(ch);
    if (out.length && (prevZwj || mark || ATTACHES.test(ch))) {
      if (mark && marks >= MAX_MARKS) continue;
      if (size < MAX_CLUSTER) {
        out[out.length - 1] += ch;
        size++;
        if (mark) marks++;
        prevZwj = ch.codePointAt(0) === ZWJ;
        continue;
      }
      if (mark) continue;
    }
    out.push(ch);
    size = 1;
    marks = 0;
    prevZwj = ch.codePointAt(0) === ZWJ;
  }
  return out;
}

/** Characters that take no room (zero-width space, joiners, direction marks, word joiner, BOM). */
const ZERO_WIDTH = /^[\u200B-\u200F\u2060-\u2064\uFEFF]+$/;
/** Is this cluster only zero-width characters? (No width; nothing to draw in a PDF.) */
export const isZeroWidth = (cluster: string): boolean => ZERO_WIDTH.test(cluster);

/** Measures fallback runs (the app installs Skia's); null = estimate. */
export type FallbackMeasure = (text: string, font: MdFont, size: number) => number;
let fallbackMeasure: FallbackMeasure | null = null;
let fallbackKey: string | null = null;
let epoch = 0;

/**
 * Installs how fallback runs are measured (the app: a Skia Paragraph, as it draws them); layouts made before are redone.
 * `key` names the fonts it measures with: installing again with the same key changes nothing (each page canvas loads
 * its own copy of the same fonts, and must not throw every cached layout away).
 */
export function setFallbackTextMeasure(fn: FallbackMeasure | null, key?: string): void {
  if (fn && key !== undefined && key === fallbackKey) return;
  fallbackMeasure = fn;
  fallbackKey = fn ? (key ?? null) : null;
  epoch++;
}

/** Changes whenever text measuring changes (part of the layout cache key). */
export const textMetricsEpoch = (): number => epoch;

/** Per 1000 em, for text no bundled font has: wide for CJK and emoji, else an average glyph. */
function estimate(text: string, size: number): number {
  let w = 0;
  for (const c of clusters(text)) w += isZeroWidth(c) ? 0 : c.codePointAt(0)! >= 0x2e80 ? 1000 : 600;
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
