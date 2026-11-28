/** A box in outline units: [minX, minY, maxX, maxY]. */
export type Bounds = [number, number, number, number];

/**
 * Where two outlines of the same stroke differ, as drawn by `traceOutline` and filled non-zero: a box holding every
 * point whose fill changed, or null when they are the same. A live stroke only changes near the pen. Its start
 * (the head of the left side, the tail of the right side and the start cap) is computed the same way every
 * frame, so the overlays clear and redraw just this box. Clearing the whole front buffer on every input
 * sample made the tip tear and flicker, and redrew the whole stroke each time (tech-spec §3).
 *
 * Why the box holds every change: the old and new outlines share all but one run of points. The fill changes
 * only where the two versions of that run, joined at their shared ends, wind around a point, which is inside
 * their hull. A quadratic segment lies in the hull of its control points, and a changed point moves the
 * segments that use it and its two neighbours on each side.
 *
 * Ported exactly to Kotlin (InkDamage.kt).
 */
export function changedBounds(prev: readonly (readonly number[])[], cur: readonly (readonly number[])[]): Bounds | null {
  const a = prev.length;
  const b = cur.length;
  const m = Math.min(a, b);
  const same = (i: number, j: number) => prev[i]![0] === cur[j]![0] && prev[i]![1] === cur[j]![1];
  let head = 0;
  while (head < m && same(head, head)) head++;
  if (head === a && a === b) return null;
  let tail = 0;
  while (tail < m - head && same(a - 1 - tail, b - 1 - tail)) tail++;
  const lo = head - 2;
  const hiA = a - tail + 1;
  const hiB = b - tail + 1;
  const box: Bounds = [Infinity, Infinity, -Infinity, -Infinity];
  const grow = (pts: readonly (readonly number[])[], from: number, to: number) => {
    for (let i = from; i <= to; i++) {
      const x = pts[i]![0]!;
      const y = pts[i]![1]!;
      if (x < box[0]) box[0] = x;
      if (y < box[1]) box[1] = y;
      if (x > box[2]) box[2] = x;
      if (y > box[3]) box[3] = y;
    }
  };
  // The change reaches the first or last point (the closing line), or a polygon too short to curve: all of both.
  if (lo <= 0 || hiA >= a - 1 || hiB >= b - 1 || a < 4 || b < 4) {
    grow(prev, 0, a - 1);
    grow(cur, 0, b - 1);
  } else {
    grow(prev, lo, hiA);
    grow(cur, lo, hiB);
  }
  return box[0] <= box[2] ? box : null;
}
