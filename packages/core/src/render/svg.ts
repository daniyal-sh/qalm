import { strokeSvgPath, HIGHLIGHTER_ALPHA } from '../geometry/stroke';
import { shapePolylines } from '../geometry/shape';
import { paperPattern, DOT_RADIUS, RULE_WIDTH } from '../geometry/paper';
import { TEXT_LINE_HEIGHT } from '../geometry/bbox';
import { escapeXml, wrapText } from './text';
import type { Page } from '../model/page';
import type { Item, PageInfo, ShapeItem } from '../types';

const n = (v: number) => (Math.round(v * 100) / 100).toString();

export function shapeSvgPath(s: Pick<ShapeItem, 'kind' | 'pts'>): string {
  return shapePolylines(s)
    .map((pl) => `M${pl.map(([x, y]) => `${n(x)},${n(y)}`).join(' L')}`)
    .join(' ');
}

/** SVG markup of one item, in page units. `ink` overrides every colour (used by the line strip). */
export function itemSvg(item: Item, opts: { assetUrl?: (id: string) => string; ink?: string } = {}): string {
  switch (item.type) {
    case 'stroke': {
      const d = strokeSvgPath(item);
      if (!d) return '';
      if (item.tool === 'highlighter') {
        const fill = opts.ink ? '#c8c8c8' : item.color;
        return `<path d="${d}" fill="${escapeXml(fill)}" fill-opacity="${HIGHLIGHTER_ALPHA}" style="mix-blend-mode:multiply"/>`;
      }
      return `<path d="${d}" fill="${escapeXml(opts.ink ?? item.color)}"/>`;
    }
    case 'shape':
      return `<path d="${shapeSvgPath(item)}" fill="none" stroke="${escapeXml(opts.ink ?? item.color)}" stroke-width="${n(item.width)}" stroke-linecap="round" stroke-linejoin="round"/>`;
    case 'text': {
      const rows = wrapText(item.text, item.w, (s) => s.length * item.fontSize * 0.55);
      const lh = item.fontSize * TEXT_LINE_HEIGHT;
      const spans = rows.map((r, i) => `<tspan x="${n(item.x)}" y="${n(item.y + item.fontSize + i * lh)}">${escapeXml(r)}</tspan>`).join('');
      return `<text font-family="Figtree, sans-serif" font-size="${n(item.fontSize)}" fill="${escapeXml(opts.ink ?? item.color)}">${spans}</text>`;
    }
    case 'image': {
      if (!opts.assetUrl) return '';
      return `<image href="${escapeXml(opts.assetUrl(item.assetId))}" x="${n(item.x)}" y="${n(item.y)}" width="${n(item.w)}" height="${n(item.h)}" preserveAspectRatio="none"/>`;
    }
  }
}

/**
 * Renders a page as SVG in page units. Draws the paper (unless `paper: false`) and items in z-order.
 * PDF backgrounds are not drawn (rasterising PDFs is platform work); such pages get a plain white background.
 */
export function renderPageSvg(info: PageInfo, page: Page, opts: { paper?: boolean; assetUrl?: (id: string) => string } = {}): string {
  const { w, h } = info.size;
  const parts: string[] = [];
  if (opts.paper !== false) {
    if (info.background.kind === 'pdf') parts.push(`<rect width="${n(w)}" height="${n(h)}" fill="#ffffff"/>`);
    else {
      const pat = paperPattern(info.paper, info.paperColor, info.size);
      parts.push(`<rect width="${n(w)}" height="${n(h)}" fill="${pat.bg}"/>`);
      if (pat.lines.length) {
        parts.push(
          `<path d="${pat.lines.map(([a, b, c, d]) => `M${n(a)},${n(b)} L${n(c)},${n(d)}`).join(' ')}" stroke="${pat.stroke}" stroke-width="${RULE_WIDTH}" fill="none"/>`,
        );
      }
      if (pat.dots.length) {
        parts.push(`<g fill="${pat.stroke}">${pat.dots.map(([x, y]) => `<circle cx="${n(x)}" cy="${n(y)}" r="${DOT_RADIUS}"/>`).join('')}</g>`);
      }
    }
  }
  for (const item of page.items()) parts.push(itemSvg(item, { assetUrl: opts.assetUrl }));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(w)} ${n(h)}" width="${n(w)}" height="${n(h)}">${parts.join('')}</svg>`;
}
