import Foundation

/// Live shapes (hold to snap, drag to adjust): the parts that run on the main thread. Recognition stays in JS
/// (@qalm/core `recognizeShape`, asked once per hold); this is a port of core's `adjustShape` and `shapePolylines`
/// (the same as Android's LiveShape.kt), so the shape follows the pen without a round trip.
enum LiveShape {
  typealias V = SIMD2<Double>

  /// Hold the pen this long (s) …
  static let holdSeconds: TimeInterval = 0.4
  /// … within this distance (mm) of where the hold began (core: SNAP_HOLD_MS / SNAP_HOLD_TOLERANCE_MM).
  static let holdMm = 2.5
  private static let axisSnapDeg = 5.0
  private static let turnSnapDeg = 6.0
  private static let deg = Double.pi / 180
  private static let open: Set<String> = ["line", "arrow", "double-arrow"]

  private static func snapAxis(_ a: Double, _ d: Double = axisSnapDeg) -> Double {
    let q = (a / (Double.pi / 2)).rounded() * (Double.pi / 2)
    return abs(a - q) <= d * deg ? q : a
  }

  private static func len(_ v: V) -> Double { (v.x * v.x + v.y * v.y).squareRoot() }

  /// core `adjustShape`: the shape's new points with the pen at `to`, having snapped with the pen at `from`.
  static func adjust(kind: String, pts: [V], from: V, to: V) -> [V] {
    if open.contains(kind) {
      guard pts.count >= 2 else { return pts }
      let a = pts[0], b = pts[1]
      let moveB = len(b - from) <= len(a - from)
      let fixed = moveB ? a : b
      let end = (moveB ? b : a) + (to - from)
      let l = len(end - fixed)
      if l < 1 { return pts }
      let ang = snapAxis(atan2(end.y - fixed.y, end.x - fixed.x))
      let e = V(fixed.x + cos(ang) * l, fixed.y + sin(ang) * l)
      return moveB ? [fixed, e] : [e, fixed]
    }
    guard !pts.isEmpty else { return pts }
    let c = pts.reduce(V(0, 0), +) / Double(pts.count)
    let u = from - c, v = to - c
    let lu = len(u), lv = len(v)
    if lu < 1e-6 || lv < 1e-6 { return pts }
    let k = min(50, max(0.05, lv / lu))
    var th = atan2(v.y, v.x) - atan2(u.y, u.x)
    th = atan2(sin(th), cos(th))
    if abs(th) <= turnSnapDeg * deg {
      th = 0
    } else if (kind == "rect" || kind == "ellipse") && pts.count >= 4 {
      let a0 = atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x)
      th = snapAxis(a0 + th, turnSnapDeg) - a0
    }
    let cs = cos(th) * k, sn = sin(th) * k
    return pts.map { p in
      let d = p - c
      return V(c.x + d.x * cs - d.y * sn, c.y + d.x * sn + d.y * cs)
    }
  }

  /// core `shapePolylines`: the outline to draw (ellipse with 64 segments, arrow heads at most 16 units).
  static func polylines(kind: String, pts: [V]) -> [[V]] {
    guard let first = pts.first else { return [] }
    switch kind {
    case "line":
      return [Array(pts.prefix(2))]
    case "arrow", "double-arrow":
      guard pts.count >= 2 else { return [] }
      let tail = pts[0], tip = pts[1]
      let l = min(16, len(tip - tail) * 0.3)
      func head(_ f: V, _ t: V) -> [V] {
        let ang = atan2(t.y - f.y, t.x - f.x)
        func barb(_ da: Double) -> V { V(t.x - l * cos(ang + da), t.y - l * sin(ang + da)) }
        return [barb(Double.pi / 7), t, barb(-Double.pi / 7)]
      }
      return kind == "arrow" ? [[tail, tip], head(tail, tip)] : [[tail, tip], head(tail, tip), head(tip, tail)]
    case "rect" where pts.count == 2:
      let a = pts[0], b = pts[1]
      return [[a, V(b.x, a.y), b, V(a.x, b.y), a]]
    case "ellipse":
      let c: V, u: V, v: V
      if pts.count >= 4 {
        c = (pts[0] + pts[2]) / 2
        u = (pts[1] - pts[0]) / 2
        v = (pts[3] - pts[0]) / 2
      } else {
        let b = pts.count > 1 ? pts[1] : first
        c = (first + b) / 2
        u = V(abs(b.x - first.x) / 2, 0)
        v = V(0, abs(b.y - first.y) / 2)
      }
      return [(0...64).map { i in
        let t = Double(i) / 64 * 2 * Double.pi
        return c + u * cos(t) + v * sin(t)
      }]
    default:  // rect, triangle, diamond, pentagon, hexagon, star
      return [pts + [first]]
    }
  }
}
