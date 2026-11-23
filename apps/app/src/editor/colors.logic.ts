// Pure helpers for the colour picker and the saved swatches (tech-spec §5).
import { HIGHLIGHTER_ALPHA, normalizeColor, splitAlpha, type SwatchTool } from '@qalm/core';

import { HIGHLIGHTER_COLORS, PEN_COLORS } from '../theme/tokens';
import type { ToolId } from './view';

/** Text and shapes use the pen list; the highlighter has its own. */
export function swatchToolFor(tool: ToolId): SwatchTool {
  return tool === 'highlighter' ? 'highlighter' : 'pen';
}

/** "Graphite" for a brand colour, else the hex ("#ff8800", or "#fde68a, 50%" with an opacity). */
export function swatchLabel(tool: SwatchTool, color: string): string {
  const { rgb, alpha } = splitAlpha(color, tool === 'highlighter' ? HIGHLIGHTER_ALPHA : 1);
  const named = tool === 'highlighter' && color.length === 9 ? undefined : (tool === 'pen' ? PEN_COLORS : HIGHLIGHTER_COLORS).find((p) => p.hex === rgb);
  if (named) return named.name;
  return tool === 'highlighter' && color.length === 9 ? `${rgb}, ${Math.round(alpha * 100)}%` : rgb;
}

/** Same colour (case and #rgb shorthand ignored). */
export function sameColor(a: string, b: string): boolean {
  return (normalizeColor(a) ?? a) === (normalizeColor(b) ?? b);
}

export interface Hsl { h: number /* 0..360 */; s: number /* 0..1 */; l: number /* 0..1 */ }

export function hslToHex({ h, s, l }: Hsl): string {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const x = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(x * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

export function hexToHsl(hex: string): Hsl {
  const v = parseInt(splitAlpha(hex).rgb.slice(1), 16);
  const r = ((v >> 16) & 255) / 255, g = ((v >> 8) & 255) / 255, b = (v & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const l = (max + min) / 2;
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s: d ? d / (1 - Math.abs(2 * l - 1)) : 0, l };
}

/**
 * The picker's tone grid for a hue: rows run from vivid to soft, columns from dark to light; the last row is greys.
 * Solid tiles (brand.md: no gradients), each a 40 px target.
 */
export const GRID_LIGHTNESS = [0.2, 0.3, 0.4, 0.5, 0.62, 0.76, 0.88] as const;
export function toneGrid(hue: number): string[][] {
  const rows = [0.95, 0.7, 0.45, 0.22].map((s) => GRID_LIGHTNESS.map((l) => hslToHex({ h: hue, s, l })));
  const greys = [0.12, 0.2, 0.35, 0.5, 0.65, 0.82, 1].map((l) => hslToHex({ h: 0, s: 0, l }));
  return [...rows, greys];
}

/** Where a dragged swatch lands: its start index moved by whole slots, clamped. */
export function dropIndex(from: number, dx: number, slot: number, count: number): number {
  return Math.max(0, Math.min(count - 1, from + Math.round(dx / slot)));
}

/** Highlighter opacities the picker offers (the default 45% among them). */
export const OPACITY_MIN = 0.2;
export const OPACITY_MAX = 0.8;
