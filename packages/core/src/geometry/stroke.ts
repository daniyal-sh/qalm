import { getStroke } from 'perfect-freehand';
import type { InkPoint, PenStyle, Smoothing, StrokeItem } from '../types';

/** Default widths in page units. */
export const PEN_WIDTHS = [1.2, 1.8, 2.8] as const;
export const HIGHLIGHTER_WIDTH = 12;
/** Highlighters are drawn at this alpha with multiply blending. */
export const HIGHLIGHTER_ALPHA = 0.45;

/** Tilt shading: a tilted pen draws a little heavier. */
export const tiltPressure = (pt: InkPoint): number => Math.min(1, pt.p * (1 + 0.6 * (1 - pt.tilt / (Math.PI / 2))));

/**
 * Pen nibs (tech-spec §2). `thinning` is how much pressure changes the width; `curve` is applied to the pressure
 * (p^curve, < 1 = softer: light pressure already gives a broad line). Fountain is the original pen.
 */
export const PEN_STYLES: Record<PenStyle, { thinning: number; curve: number }> = {
  fountain: { thinning: 0.6, curve: 1 },
  ball: { thinning: 0.15, curve: 1 },
  brush: { thinning: 0.75, curve: 0.6 },
};
export const DEFAULT_PEN_STYLE: PenStyle = 'fountain';

/**
 * Input stabilisation levels (tech-spec §2), indexed by `Smoothing`. Before getStroke, points closer than `minStep`
 * (page units) to the previous kept point are dropped, then `passes` rounds of a [1 2 1]/4 filter run over x, y and
 * pressure, with both ends pinned (so the line still reaches the pen: no lag). `streamline` goes to perfect-freehand.
 * Level 0 is exactly the original pen.
 */
export const SMOOTHING: readonly { minStep: number; passes: number; streamline: number }[] = [
  { minStep: 0, passes: 0, streamline: 0.35 },
  { minStep: 0.3, passes: 1, streamline: 0.4 },
  { minStep: 0.6, passes: 2, streamline: 0.45 },
  { minStep: 1, passes: 4, streamline: 0.5 },
];
export const DEFAULT_SMOOTHING: Smoothing = 2;

/** The stabilisation above, on [x, y, pressure] triples. Ported exactly to Swift and Kotlin (same operation order). */
export function stabilize(pts: number[][], minStep: number, passes: number): number[][] {
  const n = pts.length;
  if (n < 3) return pts;
  let out: number[][] = [pts[0]!];
  if (minStep > 0) {
    const min2 = minStep * minStep;
    for (let i = 1; i < n - 1; i++) {
      const a = out[out.length - 1]!;
      const b = pts[i]!;
      const dx = b[0]! - a[0]!;
      const dy = b[1]! - a[1]!;
      if (dx * dx + dy * dy >= min2) out.push(b);
    }
  } else {
    for (let i = 1; i < n - 1; i++) out.push(pts[i]!);
  }
  out.push(pts[n - 1]!);
  for (let k = 0; k < passes; k++) {
    const m = out.length;
    if (m < 3) break;
    const next: number[][] = [out[0]!];
    for (let i = 1; i < m - 1; i++) {
      const a = out[i - 1]!;
      const b = out[i]!;
      const c = out[i + 1]!;
      next.push([(a[0]! + 2 * b[0]! + c[0]!) / 4, (a[1]! + 2 * b[1]! + c[1]!) / 4, (a[2]! + 2 * b[2]! + c[2]!) / 4]);
    }
    next.push(out[m - 1]!);
    out = next;
  }
  return out;
}

/** Outline polygon of a stroke (perfect-freehand, the same constants as the native overlays). */
export function strokeOutline(s: Pick<StrokeItem, 'tool' | 'width' | 'points' | 'style' | 'smoothing'>): [number, number][] {
  const pts = s.points;
  let out: number[][];
  if (s.tool === 'highlighter') {
    out = getStroke(pts.map((q) => [q.x, q.y, 0.5]), { size: s.width, thinning: 0, smoothing: 0.5, streamline: 0.5, simulatePressure: false, last: true });
  } else {
    const st = PEN_STYLES[s.style ?? DEFAULT_PEN_STYLE] ?? PEN_STYLES.fountain;
    const sm = SMOOTHING[s.smoothing ?? 0] ?? SMOOTHING[0]!;
    const input = pts.map((q) => {
      const p = tiltPressure(q);
      return [q.x, q.y, st.curve === 1 ? p : Math.pow(p, st.curve)];
    });
    out = getStroke(stabilize(input, sm.minStep, sm.passes), {
      size: s.width,
      thinning: st.thinning,
      smoothing: 0.5,
      streamline: sm.streamline,
      simulatePressure: false,
      last: true,
    });
  }
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

export function strokeSvgPath(s: Pick<StrokeItem, 'tool' | 'width' | 'points' | 'style' | 'smoothing'>): string {
  return outlineToSvgPath(strokeOutline(s));
}
