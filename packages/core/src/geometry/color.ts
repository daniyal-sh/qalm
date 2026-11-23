import { HIGHLIGHTER_ALPHA } from './stroke';

/**
 * Ink colours are hex strings. Pens are opaque `#rrggbb`. A highlighter colour may carry its own opacity as
 * `#rrggbbaa`; a plain `#rrggbb` highlighter (every highlight made before custom colours) uses HIGHLIGHTER_ALPHA.
 */

/** Lowercase `#rrggbb` or `#rrggbbaa`, expanding `#rgb`/`#rgba`; null if it isn't a hex colour. */
export function normalizeColor(s: string): string | null {
  let h = s.trim().toLowerCase();
  if (h.startsWith('#')) h = h.slice(1);
  if (!/^([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(h)) return null;
  if (h.length <= 4) h = [...h].map((ch) => ch + ch).join('');
  if (h.length === 8 && h.endsWith('ff')) h = h.slice(0, 6);
  return `#${h}`;
}

/** Splits a colour into its opaque `#rrggbb` and an alpha 0..1 (`fallback` when it has none). */
export function splitAlpha(color: string, fallback = 1): { rgb: string; alpha: number } {
  const n = normalizeColor(color);
  if (!n) return { rgb: color, alpha: fallback };
  if (n.length === 9) return { rgb: n.slice(0, 7), alpha: parseInt(n.slice(7), 16) / 255 };
  return { rgb: n, alpha: fallback };
}

/** `#rrggbb` plus an alpha 0..1 → `#rrggbbaa` (or `#rrggbb` when fully opaque). */
export function withAlpha(rgb: string, alpha: number): string {
  const base = splitAlpha(rgb).rgb;
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 255);
  return a >= 255 ? base : `${base}${a.toString(16).padStart(2, '0')}`;
}

/** How an ink item is painted: highlighters use the colour's own alpha, or HIGHLIGHTER_ALPHA. */
export function inkPaint(tool: 'pen' | 'highlighter', color: string): { rgb: string; alpha: number } {
  if (tool === 'highlighter') return splitAlpha(color, HIGHLIGHTER_ALPHA);
  return { rgb: splitAlpha(color).rgb, alpha: 1 };
}
