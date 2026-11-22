import { medianLineHeight } from '../model/page';
import { escapeXml } from './text';
import { itemSvg } from './svg';
import type { Page } from '../model/page';
import type { Item, Line } from '../types';

const LABEL_W = 48;
const PAD = 8;
/** Pixels per median line height: about a 24 px x-height. */
const LINE_PX = 48;
const MAX_W = 1600;
const MAX_DRAWING_H = 240;

const isHighlighter = (it: Item) => it.type === 'stroke' && it.tool === 'highlighter';

/**
 * Renders the given lines as one image strip: black ink on white, one row per line, each labelled
 * with the matching entry of `labels` (e.g. "[1]"). Unknown keys are skipped.
 */
export function renderLinesStripSvg(page: Page, lineKeys: string[], labels: string[]): { svg: string; width: number; height: number } {
  const lines = page.lines();
  const byKey = new Map(lines.map((l) => [l.key, l]));
  const items = new Map(page.items().map((i) => [i.id, i]));
  const base = LINE_PX / medianLineHeight(lines);

  const rows: { line: Line; label: string; s: number; h: number; top: number }[] = [];
  let top = 0;
  let width = LABEL_W + 2 * PAD;
  lineKeys.forEach((key, i) => {
    const line = byKey.get(key);
    if (!line) return;
    const w = Math.max(1, line.bbox[2] - line.bbox[0]);
    const h = Math.max(1, line.bbox[3] - line.bbox[1]);
    let s = Math.min(base, (MAX_W - LABEL_W - 2 * PAD) / w);
    if (line.kind === 'drawing') s = Math.min(s, MAX_DRAWING_H / h);
    const rowH = Math.ceil(h * s + 2 * PAD);
    rows.push({ line, label: labels[i] ?? '', s, h: rowH, top });
    width = Math.max(width, Math.ceil(LABEL_W + w * s + 2 * PAD));
    top += rowH;
  });
  const height = Math.max(1, top);

  const parts = rows.map(({ line, label, s, h, top }) => {
    const ink = line.itemIds.map((id) => items.get(id)).filter((it): it is Item => it !== undefined);
    ink.sort((a, b) => Number(isHighlighter(b)) - Number(isHighlighter(a))); // highlighters underneath
    const tx = LABEL_W + PAD - line.bbox[0] * s;
    const ty = top + PAD - line.bbox[1] * s;
    return (
      (top > 0 ? `<path d="M0,${top} H${width}" stroke="#e0e0e0" stroke-width="1"/>` : '') +
      `<text x="6" y="${(top + h / 2 + 5).toFixed(1)}" font-family="monospace" font-size="14" fill="#000000">${escapeXml(label)}</text>` +
      `<g transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${s.toFixed(4)})">${ink.map((it) => itemSvg(it, { ink: '#000000' })).join('')}</g>`
    );
  });
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect width="${width}" height="${height}" fill="#ffffff"/>${parts.join('')}</svg>`;
  return { svg, width, height };
}
