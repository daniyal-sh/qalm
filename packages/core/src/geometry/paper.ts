import type { Paper, PaperColor, Size } from '../types';

export interface PaperPattern { lines: [number, number, number, number][]; dots: [number, number][]; stroke: string; bg: string }

export const PAPER_BG: Record<PaperColor, string> = { white: '#ffffff', cream: '#fbf7ee', night: '#1f1f23' };
export const PAPER_RULE: Record<PaperColor, string> = { white: '#d9dce3', cream: '#d9dce3', night: '#34343a' };
/** Default ink on night paper. */
export const NIGHT_INK = '#e4e4e7';
/** Rule line width and dot radius, in page units. */
export const RULE_WIDTH = 0.5;
export const DOT_RADIUS = 0.75;

const RULE = 24; // ruled line spacing
const GRID = 18; // grid and dot spacing
const TOP = 72; // header band above the first rule

/** Paper lines and dots in page units; shared by the Skia renderer, SVG and PDF export. */
export function paperPattern(paper: Paper, color: PaperColor, size: Size): PaperPattern {
  const { w, h } = size;
  const lines: PaperPattern['lines'] = [];
  const dots: PaperPattern['dots'] = [];
  const rules = (x0: number, x1: number, from: number, to: number) => {
    for (let y = from; y <= to + 0.001; y += RULE) lines.push([x0, y, x1, y]);
  };
  switch (paper) {
    case 'blank':
      break;
    case 'ruled':
      rules(0, w, TOP, h - 36);
      break;
    case 'dotted':
      for (let y = GRID; y < h; y += GRID) for (let x = GRID; x < w; x += GRID) dots.push([x, y]);
      break;
    case 'grid':
      for (let x = GRID; x < w; x += GRID) lines.push([x, 0, x, h]);
      for (let y = GRID; y < h; y += GRID) lines.push([0, y, w, y]);
      break;
    case 'cornell': {
      const summary = Math.round(h * 0.8);
      const cue = Math.round(w * 0.3);
      lines.push([0, TOP, w, TOP], [cue, TOP, cue, summary], [0, summary, w, summary]);
      rules(cue, w, TOP + RULE, summary - RULE);
      break;
    }
    case 'weekly': {
      // Two columns of four boxes under a header band: seven days plus a notes box.
      const bottom = h - 36;
      const rowH = (bottom - TOP) / 4;
      lines.push([w / 2, TOP, w / 2, bottom]);
      for (let i = 0; i <= 4; i++) lines.push([0, TOP + i * rowH, w, TOP + i * rowH]);
      break;
    }
  }
  return { lines, dots, stroke: PAPER_RULE[color], bg: PAPER_BG[color] };
}
