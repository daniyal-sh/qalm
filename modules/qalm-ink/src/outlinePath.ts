/** Anything with moveTo / quadTo / close: Path2D (as quadraticCurveTo), SkPath, android.graphics.Path. */
export interface PathSink {
  moveTo(x: number, y: number): unknown;
  quadTo(cx: number, cy: number, x: number, y: number): unknown;
  close(): unknown;
}

/**
 * Turns a perfect-freehand outline polygon into a closed, smoothed path: quadratic curves through
 * the midpoints, with each outline point as the control point. Every renderer (PageCanvas, the web
 * overlay, the Android overlay) builds stroke paths this way, filled with the non-zero rule.
 */
export function traceOutline(outline: readonly (readonly number[])[], sink: PathSink): void {
  const n = outline.length;
  if (n === 0) return;
  const first = outline[0]!;
  const last = outline[n - 1]!;
  sink.moveTo((last[0]! + first[0]!) / 2, (last[1]! + first[1]!) / 2);
  for (let i = 0; i < n; i++) {
    const a = outline[i]!;
    const b = outline[(i + 1) % n]!;
    sink.quadTo(a[0]!, a[1]!, (a[0]! + b[0]!) / 2, (a[1]! + b[1]!) / 2);
  }
  sink.close();
}
