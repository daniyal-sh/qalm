import { BlendMode, LineCapStyle, PDFDocument, StandardFonts, rgb, type PDFEmbeddedPage, type PDFFont, type PDFImage, type RGB } from 'pdf-lib';
import { strokeSvgPath, HIGHLIGHTER_ALPHA } from '../geometry/stroke';
import { paperPattern, DOT_RADIUS, RULE_WIDTH } from '../geometry/paper';
import { TEXT_LINE_HEIGHT } from '../geometry/bbox';
import { shapeSvgPath } from '../render/svg';
import { wrapText } from '../render/text';
import type { Notebook } from '../model/notebook';
import type { Page } from '../model/page';

export function parseColor(hex: string): RGB {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const v = parseInt(h.slice(0, 6), 16);
  if (h.length < 6 || Number.isNaN(v)) return rgb(0, 0, 0);
  return rgb(((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255);
}

function sanitize(font: PDFFont, s: string): string {
  let out = '';
  for (const ch of s) {
    try {
      font.widthOfTextAtSize(ch, 10);
      out += ch;
    } catch {
      out += '?';
    }
  }
  return out;
}

/**
 * Exports a notebook as PDF: paper or the source PDF page as background, strokes and shapes as vector paths,
 * images (PNG/JPEG) and text boxes (Helvetica; characters it can't encode become "?").
 */
export async function exportPdf(
  nb: Notebook,
  loadPage: (pageId: string) => Promise<Page>,
  getAsset: (id: string) => Promise<Uint8Array>,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(nb.meta().title ?? '');
  const font = await pdf.embedFont(StandardFonts.Helvetica);
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
      const b = await getAsset(assetId);
      const img = b[0] === 0x89 && b[1] === 0x50 ? await pdf.embedPng(b) : b[0] === 0xff && b[1] === 0xd8 ? await pdf.embedJpg(b) : null;
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
    for (const item of page.items()) {
      switch (item.type) {
        case 'stroke': {
          const d = strokeSvgPath(item);
          if (!d) break;
          const hl = item.tool === 'highlighter';
          out.drawSvgPath(d, {
            x: 0,
            y: H,
            color: parseColor(item.color),
            borderWidth: 0,
            ...(hl ? { opacity: HIGHLIGHTER_ALPHA, blendMode: BlendMode.Multiply } : {}),
          });
          break;
        }
        case 'shape':
          out.drawSvgPath(shapeSvgPath(item), { x: 0, y: H, borderColor: parseColor(item.color), borderWidth: item.width, borderLineCap: LineCapStyle.Round });
          break;
        case 'image': {
          const img = await image(item.assetId);
          if (img) out.drawImage(img, { x: item.x, y: H - item.y - item.h, width: item.w, height: item.h });
          break;
        }
        case 'text': {
          const rows = wrapText(sanitize(font, item.text), item.w, (s) => font.widthOfTextAtSize(s, item.fontSize));
          const color = parseColor(item.color);
          rows.forEach((r, i) => {
            if (r) out.drawText(r, { x: item.x, y: H - (item.y + item.fontSize + i * item.fontSize * TEXT_LINE_HEIGHT), size: item.fontSize, font, color });
          });
          break;
        }
      }
    }
  }
  return pdf.save();
}
