import { getStroke } from 'perfect-freehand';
import type { InkPoint, StrokeItem } from '../types';

/** Default widths in page units. */
export const PEN_WIDTHS = [1.2, 1.8, 2.8] as const;
export const HIGHLIGHTER_WIDTH = 12;
/** Highlighters are drawn at this alpha with multiply blending. */
export const HIGHLIGHTER_ALPHA = 0.45;

/** Tilt shading: a tilted pen draws a little heavier. */
export const tiltPressure = (pt: InkPoint): number => Math.min(1, pt.p * (1 + 0.6 * (1 - pt.tilt / (Math.PI / 2))));

/** Outline polygon of a stroke (perfect-freehand, the same constants as the native overlays). */
export function strokeOutline(s: Pick<StrokeItem, 'tool' | 'width' | 'points'>): [number, number][] {
  const pts = s.points;
  const out =
    s.tool === 'highlighter'
      ? getStroke(pts.map((q) => [q.x, q.y, 0.5]), { size: s.width, thinning: 0, smoothing: 0.5, streamline: 0.5, simulatePressure: false, last: true })
      : getStroke(pts.map((q) => [q.x, q.y, tiltPressure(q)]), { size: s.width, thinning: 0.6, smoothing: 0.5, streamline: 0.35, simulatePressure: false, last: true });
  return out.map((p) => [p[0]!, p[1]!]);
}

const f = (n: number) => (Math.round(n * 100) / 100).toString();

/** SVG path data for a filled outline polygon (quadratic smoothing through midpoints). */
export function outlineToSvgPath(pts: [number, number][]): string {
  const n = pts.length;
  if (n === 0) return '';
  if (n < 4) return `M${pts.map(([x, y]) => `${f(x)},${f(y)}`).join(' L')} Z`;
  const [a, b, c] = [pts[0]!, pts[1]!, pts[2]!];
  let d = `M${f(a[0])},${f(a[1])} Q${f(b[0])},${f(b[1])} ${f((b[0] + c[0]) / 2)},${f((b[1] + c[1]) / 2)} T`;
  for (let i = 2; i < n - 1; i++) {
    const p = pts[i]!;
    const q = pts[i + 1]!;
    d += `${f((p[0] + q[0]) / 2)},${f((p[1] + q[1]) / 2)} `;
  }
  return d + 'Z';
}

export function strokeSvgPath(s: Pick<StrokeItem, 'tool' | 'width' | 'points'>): string {
  return outlineToSvgPath(strokeOutline(s));
}
