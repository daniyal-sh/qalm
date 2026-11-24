import { strokeSvgPath } from '../geometry/stroke';
import { inkPaint } from '../geometry/color';
import { shapePolylines } from '../geometry/shape';
import { itemsOnPaper, paperPattern, DOT_RADIUS, RULE_WIDTH } from '../geometry/paper';
import { TEXT_LINE_HEIGHT } from '../geometry/bbox';
import { layoutMarkdown, rendersMarkdown } from '../markdown/layout';
import type { MdFont } from '../markdown/fonts';
import { escapeXml, wrapText } from './text';
import type { Page } from '../model/page';
import type { Item, PageInfo, ShapeItem, TextItem } from '../types';

const n = (v: number) => (Math.round(v * 100) / 100).toString();

export function shapeSvgPath(s: Pick<ShapeItem, 'kind' | 'pts'>): string {
  return shapePolylines(s)
    .map((pl) => `M${pl.map(([x, y]) => `${n(x)},${n(y)}`).join(' L')}`)
    .join(' ');
}

/** ` transform="rotate(…)"` for a turned text box or image (about its top-left corner). */
function turn(item: { x: number; y: number; rot?: number }): string {
  return item.rot ? ` transform="rotate(${n((item.rot * 180) / Math.PI)} ${n(item.x)} ${n(item.y)})"` : '';
}

/** SVG font attributes of each Markdown font (the server's resvg loads the same files). */
const SVG_FONT: Record<MdFont, string> = {
  r: 'font-family="Figtree"',
  b: 'font-family="Figtree" font-weight="700"',
  i: 'font-family="Figtree" font-style="italic"',
  bi: 'font-family="Figtree" font-weight="700" font-style="italic"',
  m: 'font-family="Geist Mono"',
  x: 'font-family="Noto Sans Math"',
};

/**
 * A Markdown text box (`format: 'md'`) as SVG: its layout's ops, in `color`. Synchronous: maths MathJax hasn't loaded
 * for yet draws as its placeholder (raw TeX, muted), so callers that need the real maths `await loadMathFor([item])`
 * first (MathJax loads on demand: `markdown/math.ts`).
 */
export function markdownSvg(item: Pick<TextItem, 'x' | 'y' | 'w' | 'text' | 'fontSize' | 'rot'>, color: string): string {
  const fill = escapeXml(color);
  const parts = layoutMarkdown(item.text, item.w, item.fontSize).ops.map((op) => {
    if (op.k === 'text') return `<text x="${n(op.x)}" y="${n(op.y)}" ${SVG_FONT[op.font]} font-size="${n(op.size)}"${op.alpha !== undefined ? ` fill-opacity="${n(op.alpha)}"` : ''} xml:space="preserve">${escapeXml(op.text)}</text>`;
    if (op.k === 'rect') return `<rect x="${n(op.x)}" y="${n(op.y)}" width="${n(op.w)}" height="${n(op.h)}"${op.alpha < 1 ? ` fill-opacity="${n(op.alpha)}"` : ''}/>`;
    return `<path transform="translate(${n(op.x)} ${n(op.y)}) scale(${op.s.toFixed(5)})" d="${op.d}"/>`;
  });
  const rot = item.rot ? ` rotate(${n((item.rot * 180) / Math.PI)})` : '';
  // The layout places glyphs by their plain advances: no kerning or ligatures here either. resvg applies both by default
  // and only honours turning them off as a style (not as attributes).
  return `<g transform="translate(${n(item.x)} ${n(item.y)})${rot}" fill="${fill}" style="font-kerning:none;font-variant-ligatures:none">${parts.join('')}</g>`;
}

/** SVG markup of one item, in page units. `ink` overrides every colour (used by the line strip). */
export function itemSvg(item: Item, opts: { assetUrl?: (id: string) => string; ink?: string } = {}): string {
  switch (item.type) {
    case 'stroke': {
      const d = strokeSvgPath(item);
      if (!d) return '';
      if (item.tool === 'highlighter') {
        const paint = inkPaint('highlighter', item.color);
        const fill = opts.ink ? '#c8c8c8' : paint.rgb;
        return `<path d="${d}" fill="${escapeXml(fill)}" fill-opacity="${n(paint.alpha)}" style="mix-blend-mode:multiply"/>`;
      }
      return `<path d="${d}" fill="${escapeXml(opts.ink ?? inkPaint('pen', item.color).rgb)}"/>`;
    }
    case 'shape':
      return `<path d="${shapeSvgPath(item)}" fill="none" stroke="${escapeXml(opts.ink ?? item.color)}" stroke-width="${n(item.width)}" stroke-linecap="round" stroke-linejoin="round"/>`;
    case 'text': {
      if (rendersMarkdown(item)) return markdownSvg(item, opts.ink ?? item.color);
      const rows = wrapText(item.text, item.w, (s) => s.length * item.fontSize * 0.55);
      const lh = item.fontSize * TEXT_LINE_HEIGHT;
      const spans = rows.map((r, i) => `<tspan x="${n(item.x)}" y="${n(item.y + item.fontSize + i * lh)}">${escapeXml(r)}</tspan>`).join('');
      return `<text font-family="Figtree, sans-serif" font-size="${n(item.fontSize)}" fill="${escapeXml(opts.ink ?? item.color)}"${turn(item)}>${spans}</text>`;
    }
    case 'image': {
      if (!opts.assetUrl) return '';
      return `<image href="${escapeXml(opts.assetUrl(item.assetId))}" x="${n(item.x)}" y="${n(item.y)}" width="${n(item.w)}" height="${n(item.h)}" preserveAspectRatio="none"${turn(item)}/>`;
    }
  }
}

/**
 * Renders a page as SVG in page units. Draws the paper (unless `paper: false`) and items in z-order.
 * PDF backgrounds are not drawn (rasterising PDFs is platform work); such pages get a plain white background.
 * Markdown boxes' maths needs MathJax, loaded on demand: `await loadMathFor(page.items())` first, or it draws as its
 * placeholder.
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
  for (const item of itemsOnPaper(page.items(), info.paperColor)) parts.push(itemSvg(item, { assetUrl: opts.assetUrl }));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(w)} ${n(h)}" width="${n(w)}" height="${n(h)}">${parts.join('')}</svg>`;
}
