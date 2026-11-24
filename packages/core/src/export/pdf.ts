import fontkit from '@pdf-lib/fontkit';
import { BlendMode, LineCapStyle, PDFDocument, StandardFonts, degrees, rgb, type PDFEmbeddedPage, type PDFFont, type PDFImage, type PDFPage, type RGB } from 'pdf-lib';
import { strokeSvgPath } from '../geometry/stroke';
import { inkPaint } from '../geometry/color';
import { itemsOnPaper, paperPattern, DOT_RADIUS, RULE_WIDTH } from '../geometry/paper';
import { TEXT_LINE_HEIGHT } from '../geometry/bbox';
import { shapeSvgPath } from '../render/svg';
import { wrapText } from '../render/text';
import type { Notebook } from '../model/notebook';
import type { Page } from '../model/page';
import { FIGTREE_REGULAR_B64 } from './figtreeFont';
import { FONT_B_B64, FONT_BI_B64, FONT_I_B64, FONT_M_B64, FONT_X_B64 } from '../markdown/fontData';
import { layoutMarkdown, rendersMarkdown } from '../markdown/layout';
import { clusters, type MdFont } from '../markdown/fonts';
import type { TextItem } from '../types';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function fromBase64(s: string): Uint8Array {
  const out = new Uint8Array(Math.floor((s.length * 3) / 4) - (s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0));
  let j = 0;
  for (let i = 0; i < s.length; i += 4) {
    const n = (B64.indexOf(s[i]!) << 18) | (B64.indexOf(s[i + 1]!) << 12) | ((B64.indexOf(s[i + 2]!) & 63) << 6) | (B64.indexOf(s[i + 3]!) & 63);
    if (j < out.length) out[j++] = (n >> 16) & 255;
    if (j < out.length) out[j++] = (n >> 8) & 255;
    if (j < out.length) out[j++] = n & 255;
  }
  return out;
}

let figtree: Uint8Array | undefined;
/** The Figtree Regular bytes embedded into exported PDFs (the font text boxes use on screen). */
export const figtreeBytes = (): Uint8Array => (figtree ??= fromBase64(FIGTREE_REGULAR_B64));

export function parseColor(hex: string): RGB {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const v = parseInt(h.slice(0, 6), 16);
  if (h.length < 6 || Number.isNaN(v)) return rgb(0, 0, 0);
  return rgb(((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255);
}

/** A piece of a text row in one font. */
interface Run { font: PDFFont; text: string }

/**
 * Splits text into runs: Figtree where it has the glyph (the font on screen), else PDF's built-in Symbol font
 * (maths and Greek: ∫ √ π ∞ α …), else "?" (CJK, emoji).
 */
function textRuns(fonts: { font: PDFFont; has: Set<number> }[], s: string): Run[] {
  const runs: Run[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    const hit = fonts.find((f) => f.has.has(cp));
    const font = hit?.font ?? fonts[0]!.font;
    const text = hit ? ch : '?';
    const last = runs[runs.length - 1];
    if (last?.font === font) last.text += text;
    else runs.push({ font, text });
  }
  return runs;
}

/** The layout places glyphs by their plain advances: no ligatures (fi, fl, ->) in Markdown boxes' text. */
const NO_LIGATURES = { liga: false, clig: false, dlig: false, calt: false };

const MD_FONT_B64: Record<Exclude<MdFont, 'r'>, string> = { b: FONT_B_B64, i: FONT_I_B64, bi: FONT_BI_B64, m: FONT_M_B64, x: FONT_X_B64 };

/**
 * Draws a Markdown text box (`format: 'md'`) from its layout, the same ops the page draws: text runs in their fonts,
 * tints and rules as rectangles, maths as paths. `font` embeds each font on first use.
 */
async function drawMarkdown(out: PDFPage, H: number, item: TextItem, font: (f: MdFont) => Promise<PDFFont>): Promise<void> {
  const color = parseColor(item.color);
  const rot = item.rot ?? 0;
  const [cos, sin] = [Math.cos(rot), Math.sin(rot)];
  // Box-local (u right, v down) to PDF space (y up); pdf-lib turns counter-clockwise, ours turn clockwise.
  const at = (u: number, v: number) => ({ x: item.x + u * cos - v * sin, y: H - (item.y + u * sin + v * cos) });
  const rotate = rot ? { rotate: degrees((-rot * 180) / Math.PI) } : {};
  for (const op of layoutMarkdown(item.text, item.w, item.fontSize).ops) {
    // Text no bundled font has draws as `?` (one per character), as plain boxes do.
    if (op.k === 'text') out.drawText(op.fallback ? clusters(op.text).map(() => '?').join('') : op.text, { ...at(op.x, op.y), size: op.size, font: await font(op.font), color, ...rotate });
    else if (op.k === 'rect') out.drawRectangle({ ...at(op.x, op.y + op.h), width: op.w, height: op.h, color, ...(op.alpha < 1 ? { opacity: op.alpha } : {}), ...rotate });
    else out.drawSvgPath(op.d, { ...at(op.x, op.y), scale: op.s, color, borderWidth: 0, ...rotate });
  }
}

const runsWidth = (runs: Run[], size: number) => runs.reduce((w, r) => w + r.font.widthOfTextAtSize(r.text, size), 0);

const isPng = (b: Uint8Array) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
const isJpg = (b: Uint8Array) => b[0] === 0xff && b[1] === 0xd8;

export interface ExportPdfOptions {
  /**
   * Turns an image PDF can't hold (WebP, GIF, HEIC, …) into PNG, or null if it can't. PNG and JPEG go in as they
   * are. The app does this with the platform's decoder.
   */
  toPng?: (bytes: Uint8Array) => Promise<Uint8Array | null>;
  /** Called once for each image asset that still couldn't go in (it is left out of the PDF). */
  onSkippedImage?: (assetId: string) => void;
}

/**
 * Exports a notebook as PDF: paper or the source PDF page as background, strokes and shapes as vector paths,
 * images (PNG and JPEG; others via `opts.toPng`) and text boxes (Figtree, subset, wrapped with its metrics like on
 * screen; see `textRuns` for characters Figtree lacks). Markdown boxes draw their layout (`drawMarkdown`).
 */
export async function exportPdf(
  nb: Notebook,
  loadPage: (pageId: string) => Promise<Page>,
  getAsset: (id: string) => Promise<Uint8Array>,
  opts: ExportPdfOptions = {},
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(nb.meta().title ?? '');
  pdf.registerFontkit(fontkit);
  // Embedded on first use, so a PDF without text boxes carries no fonts.
  let fonts: { font: PDFFont; has: Set<number> }[] | undefined;
  const textFonts = async () => {
    if (!fonts) {
      const fig = await pdf.embedFont(figtreeBytes(), { subset: true });
      const sym = await pdf.embedFont(StandardFonts.Symbol);
      // Symbol's character set includes Latin letters it draws as Greek: only use it for what Figtree lacks.
      fonts = [fig, sym].map((font) => ({ font, has: new Set(font.getCharacterSet()) }));
    }
    return fonts;
  };
  // Markdown boxes' fonts, each embedded (subset) on first use.
  const mdFonts = new Map<MdFont, Promise<PDFFont>>();
  const mdFont = (f: MdFont) => {
    let p = mdFonts.get(f);
    if (!p) mdFonts.set(f, (p = pdf.embedFont(f === 'r' ? figtreeBytes() : fromBase64(MD_FONT_B64[f]), { subset: true, features: NO_LIGATURES })));
    return p;
  };
  const sources = new Map<string, Promise<PDFDocument>>();
  const embedded = new Map<string, PDFEmbeddedPage>();
  const images = new Map<string, PDFImage | null>();

  const source = (assetId: string) => {
    let p = sources.get(assetId);
    if (!p) sources.set(assetId, (p = getAsset(assetId).then((b) => PDFDocument.load(b, { ignoreEncryption: true }))));
    return p;
  };
  const image = async (assetId: string) => {
    if (!images.has(assetId)) {
      let b: Uint8Array | null = await getAsset(assetId);
      if (!isPng(b) && !isJpg(b)) b = (await opts.toPng?.(b).catch(() => null)) ?? null;
      const img = b && isPng(b) ? await pdf.embedPng(b) : b && isJpg(b) ? await pdf.embedJpg(b) : null;
      if (!img) opts.onSkippedImage?.(assetId);
      images.set(assetId, img);
    }
    return images.get(assetId) ?? null;
  };

  for (const info of nb.pages()) {
    const { w: W, h: H } = info.size;
    const out = pdf.addPage([W, H]);
    const bg = info.background;
    if (bg.kind === 'pdf') {
      const k = `${bg.assetId}#${bg.pageIndex}`;
      let emb = embedded.get(k);
      if (!emb) {
        const src = await source(bg.assetId);
        [emb] = await pdf.embedPdf(src, [bg.pageIndex]);
        embedded.set(k, emb!);
      }
      out.drawPage(emb!, { x: 0, y: 0, width: W, height: H });
    } else {
      const pat = paperPattern(info.paper, info.paperColor, info.size);
      const stroke = parseColor(pat.stroke);
      out.drawRectangle({ x: 0, y: 0, width: W, height: H, color: parseColor(pat.bg) });
      for (const [x0, y0, x1, y1] of pat.lines) out.drawLine({ start: { x: x0, y: H - y0 }, end: { x: x1, y: H - y1 }, thickness: RULE_WIDTH, color: stroke });
      for (const [x, y] of pat.dots) out.drawCircle({ x, y: H - y, size: DOT_RADIUS, color: stroke });
    }

    const page = await loadPage(info.id);
    for (const item of itemsOnPaper(page.items(), info.paperColor)) {
      switch (item.type) {
        case 'stroke': {
          const d = strokeSvgPath(item);
          if (!d) break;
          const hl = item.tool === 'highlighter';
          const paint = inkPaint(item.tool, item.color);
          out.drawSvgPath(d, {
            x: 0,
            y: H,
            color: parseColor(paint.rgb),
            borderWidth: 0,
            ...(hl ? { opacity: paint.alpha, blendMode: BlendMode.Multiply } : {}),
          });
          break;
        }
        case 'shape':
          out.drawSvgPath(shapeSvgPath(item), { x: 0, y: H, borderColor: parseColor(item.color), borderWidth: item.width, borderLineCap: LineCapStyle.Round });
          break;
        case 'image': {
          const img = await image(item.assetId);
          if (!img) break;
          // pdf-lib turns about the bottom-left corner, counter-clockwise (y points up); ours turn about the top-left.
          const r = item.rot ?? 0;
          const bl = { x: item.x - item.h * Math.sin(r), y: item.y + item.h * Math.cos(r) };
          out.drawImage(img, { x: bl.x, y: H - bl.y, width: item.w, height: item.h, ...(r ? { rotate: degrees((-r * 180) / Math.PI) } : {}) });
          break;
        }
        case 'text': {
          if (rendersMarkdown(item)) {
            await drawMarkdown(out, H, item, mdFont);
            break;
          }
          const fs = await textFonts();
          const size = item.fontSize;
          const rows = wrapText(item.text, item.w, (s) => runsWidth(textRuns(fs, s), size));
          const color = parseColor(item.color);
          const rot = item.rot ?? 0;
          const [cos, sin] = [Math.cos(rot), Math.sin(rot)];
          rows.forEach((row, i) => {
            const down = size + i * size * TEXT_LINE_HEIGHT; // baseline below the top-left corner
            let along = 0; // along the baseline, from the box's left edge
            for (const r of textRuns(fs, row)) {
              // Page space (y down): left edge + along·(cos, sin) + down·(−sin, cos).
              const x = item.x + along * cos - down * sin;
              const y = item.y + along * sin + down * cos;
              if (r.text.trim()) out.drawText(r.text, { x, y: H - y, size, font: r.font, color, ...(rot ? { rotate: degrees((-rot * 180) / Math.PI) } : {}) });
              along += r.font.widthOfTextAtSize(r.text, size);
            }
          });
          break;
        }
      }
    }
  }
  return pdf.save();
}
