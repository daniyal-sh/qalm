/** Anything with moveTo / quadTo / close: Path2D (as quadraticCurveTo), SkPath, android.graphics.Path. */
export interface PathSink {
  moveTo(x: number, y: number): unknown;
  quadTo(cx: number, cy: number, x: number, y: number): unknown;
  close(): unknown;
}

/**
 * Turns a perfect-freehand outline polygon into a closed, smoothed path. This is exactly the construction of
 * `outlineToSvgPath` in @qalm/core and `Freehand.path` on iOS (perfect-freehand's getSvgPathFromStroke):
 * M p0, Q p1 mid(p1,p2), then Q p[i] mid(p[i],p[i+1]) for i = 2..n-2, close. Fewer than 4 points draws the polygon.
 * Every renderer (PageCanvas, the web overlay, the Android overlay) must build stroke paths this way, filled non-zero.
 */
export interface LineSink extends PathSink { lineTo(x: number, y: number): unknown }
export function traceOutline(outline: readonly (readonly number[])[], sink: LineSink): void {
  const n = outline.length;
  if (n === 0) return;
  const p = (i: number) => outline[i]!;
  sink.moveTo(p(0)[0]!, p(0)[1]!);
  if (n < 4) {
    for (let i = 1; i < n; i++) sink.lineTo(p(i)[0]!, p(i)[1]!);
    sink.close();
    return;
  }
  for (let i = 1; i < n - 1; i++) {
    const a = p(i), b = p(i + 1);
    sink.quadTo(a[0]!, a[1]!, (a[0]! + b[0]!) / 2, (a[1]! + b[1]!) / 2);
  }
  sink.close();
}
