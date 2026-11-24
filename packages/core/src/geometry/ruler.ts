// The ruler (tech-spec §7, Ruler): an on-screen straightedge that lives in the editor, not in the page. Its pose is in
// screen (window) px: centre, angle (radians, clockwise), length and thickness. While it is shown, a pen stroke that
// starts near one of its long edges is drawn straight along that edge: every point is projected onto the edge line
// (pushed out by half the pen width so the ink sits beside the ruler, not under it), keeping its pressure and time.
// The native overlays carry ports of `rulerEdgeAt` and `projectOnLine` (RulerSnap.kt, RulerSnap.swift).

type P = [number, number];

export interface RulerPose {
  /** Centre, screen px. */
  cx: number;
  cy: number;
  /** Radians, clockwise (screen y runs down); 0 = horizontal. */
  angle: number;
  /** Along its edges, px. */
  length: number;
  /** Across, px. */
  thickness: number;
}

export const RULER = {
  /** Default size (px / dp). */
  length: 720,
  thickness: 72,
  /** Angles snap to multiples of 45° within this many degrees. */
  snapDeg: 4,
  /** A stroke snaps when it starts within this many px outside a long edge (or anywhere over the ruler's half on that side). */
  snapPx: 24,
} as const;

const norm = (a: number) => {
  const t = 2 * Math.PI;
  return ((a % t) + t) % t;
};

/** The angle, snapped to the nearest multiple of 45° when within `tolDeg` of it. */
export function snapRulerAngle(angle: number, tolDeg: number = RULER.snapDeg): number {
  const step = Math.PI / 4;
  const k = Math.round(angle / step);
  return Math.abs(angle - k * step) <= (tolDeg * Math.PI) / 180 ? norm(k * step) : norm(angle);
}

/** The angle shown on the ruler: 0–179°, whole degrees (a ruler at 190° reads 10°). */
export function rulerDegrees(angle: number): number {
  const d = Math.round((norm(angle) * 180) / Math.PI) % 180;
  return d;
}

/** One long edge: from `a` to `b` (px), with `n` its outward unit normal. */
export interface RulerEdge {
  a: P;
  b: P;
  n: P;
}

/** The ruler's two long edges (the "top" one first, at angle 0 the upper edge). */
export function rulerEdges(r: RulerPose): [RulerEdge, RulerEdge] {
  const ux = Math.cos(r.angle), uy = Math.sin(r.angle);
  const nx = Math.sin(r.angle), ny = -Math.cos(r.angle); // "up" from the ruler's own frame
  const hl = r.length / 2, ht = r.thickness / 2;
  const edge = (s: 1 | -1): RulerEdge => {
    const ox = r.cx + nx * ht * s, oy = r.cy + ny * ht * s;
    return { a: [ox - ux * hl, oy - uy * hl], b: [ox + ux * hl, oy + uy * hl], n: [nx * s, ny * s] };
  };
  return [edge(1), edge(-1)];
}

/**
 * The edge a stroke starting at `p` (px) snaps to, or null: `p` lies along the ruler (within its length, plus `zone`
 * at each end) and either within `zone` px outside that edge or over the ruler's half next to it.
 */
export function rulerEdgeAt(r: RulerPose, p: P, zone: number = RULER.snapPx): RulerEdge | null {
  const ux = Math.cos(r.angle), uy = Math.sin(r.angle);
  const dx = p[0] - r.cx, dy = p[1] - r.cy;
  const along = dx * ux + dy * uy;
  if (Math.abs(along) > r.length / 2 + zone) return null;
  // Signed distance from the centre line, positive towards the first edge.
  const [e0, e1] = rulerEdges(r);
  const across = dx * e0.n[0] + dy * e0.n[1];
  const ht = r.thickness / 2;
  if (across >= 0 && across <= ht + zone) return e0;
  if (across < 0 && -across <= ht + zone) return e1;
  return null;
}

/** `p` projected onto the (infinite) line through a and b. */
export function projectOnLine(p: P, a: P, b: P): P {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (!len2) return [a[0], a[1]];
  const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  return [a[0] + dx * t, a[1] + dy * t];
}

/** The line a stroke follows along `edge`, in the page's units: the edge pushed out by `offset` (half the pen width). */
export function rulerLine(edge: RulerEdge, toPage: (p: P) => P, offset: number): { a: P; b: P } {
  const a = toPage(edge.a), b = toPage(edge.b);
  const n0 = toPage([edge.a[0] + edge.n[0], edge.a[1] + edge.n[1]]);
  // The normal in page units (the page may be scaled, never sheared).
  let nx = n0[0] - a[0], ny = n0[1] - a[1];
  const l = Math.hypot(nx, ny) || 1;
  nx /= l;
  ny /= l;
  return { a: [a[0] + nx * offset, a[1] + ny * offset], b: [b[0] + nx * offset, b[1] + ny * offset] };
}

/** Points projected onto a line, keeping everything else (pressure, tilt, time). */
export function snapToLine<T extends { x: number; y: number }>(points: readonly T[], line: { a: P; b: P }): T[] {
  return points.map((q) => {
    const [x, y] = projectOnLine([q.x, q.y], line.a, line.b);
    return { ...q, x, y };
  });
}
