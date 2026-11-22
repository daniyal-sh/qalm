// Swift port of perfect-freehand (https://github.com/steveruizok/perfect-freehand)
// MIT License, Copyright (c) 2021 Stephen Ruiz Ltd.
//
// A faithful port of getStrokePoints + getStrokeOutlinePoints (`main`, equivalent to npm 1.2.x),
// restricted to the options Qalm uses: no taper, round caps, linear easing. With simulatePressure false
// (which Qalm always uses), the simulated-pressure branch has no effect, so it is left out.
// Loops keep the same floating-point accumulation (`t += step`) as the JS, so the outlines match point for point.
// The settings live in `FreehandSettings` below (tech-spec §2) and must stay the same as @qalm/core.

import CoreGraphics
import Foundation

struct FHVec: Equatable {
  var x: Double
  var y: Double
  init(_ x: Double, _ y: Double) { self.x = x; self.y = y }
}

/// Input point. `pressure == nil` is perfect-freehand's "no pressure" (an undefined third element).
struct FHInput {
  var x: Double
  var y: Double
  var pressure: Double?
}

struct FHStrokePoint {
  var point: FHVec
  var pressure: Double
  var vector: FHVec
  var distance: Double
  var runningLength: Double
}

struct FreehandOptions {
  var size: Double
  var thinning: Double
  var smoothing: Double
  var streamline: Double
  var last: Bool
}

/// Qalm's fixed stroke settings (tech-spec §2).
enum FreehandSettings {
  static func tiltPressure(p: Double, tilt: Double) -> Double {
    return min(1, p * (1 + 0.6 * (1 - tilt / (Double.pi / 2))))
  }

  static func pen(width: Double) -> FreehandOptions {
    return FreehandOptions(size: width, thinning: 0.6, smoothing: 0.5, streamline: 0.35, last: true)
  }

  static func highlighter(width: Double) -> FreehandOptions {
    return FreehandOptions(size: width, thinning: 0, smoothing: 0.5, streamline: 0.5, last: true)
  }

  static let highlighterPressure = 0.5
  static let highlighterAlpha: Float = 0.45
}

enum Freehand {
  // constants.ts
  static let FIXED_PI = Double.pi + 0.0001
  static let START_CAP_SEGMENTS = 13.0
  static let END_CAP_SEGMENTS = 29.0
  static let CORNER_CAP_SEGMENTS = 13.0
  static let END_NOISE_THRESHOLD = 3.0
  static let MIN_STREAMLINE_T = 0.15
  static let STREAMLINE_T_RANGE = 0.85
  static let MIN_RADIUS = 0.01
  static let DEFAULT_FIRST_PRESSURE = 0.25
  static let DEFAULT_PRESSURE = 0.5

  // vec.ts
  @inline(__always) static func neg(_ a: FHVec) -> FHVec { FHVec(-a.x, -a.y) }
  @inline(__always) static func add(_ a: FHVec, _ b: FHVec) -> FHVec { FHVec(a.x + b.x, a.y + b.y) }
  @inline(__always) static func sub(_ a: FHVec, _ b: FHVec) -> FHVec { FHVec(a.x - b.x, a.y - b.y) }
  @inline(__always) static func mul(_ a: FHVec, _ n: Double) -> FHVec { FHVec(a.x * n, a.y * n) }
  @inline(__always) static func div(_ a: FHVec, _ n: Double) -> FHVec { FHVec(a.x / n, a.y / n) }
  @inline(__always) static func per(_ a: FHVec) -> FHVec { FHVec(a.y, -a.x) }
  @inline(__always) static func dpr(_ a: FHVec, _ b: FHVec) -> Double { a.x * b.x + a.y * b.y }
  @inline(__always) static func isEqual(_ a: FHVec, _ b: FHVec) -> Bool { a.x == b.x && a.y == b.y }
  @inline(__always) static func len(_ a: FHVec) -> Double { hypot(a.x, a.y) }
  @inline(__always) static func dist2(_ a: FHVec, _ b: FHVec) -> Double {
    let dx = a.x - b.x
    let dy = a.y - b.y
    return dx * dx + dy * dy
  }
  @inline(__always) static func uni(_ a: FHVec) -> FHVec { div(a, len(a)) }
  @inline(__always) static func dist(_ a: FHVec, _ b: FHVec) -> Double { hypot(a.y - b.y, a.x - b.x) }
  @inline(__always) static func rotAround(_ a: FHVec, _ c: FHVec, _ r: Double) -> FHVec {
    let s = sin(r)
    let co = cos(r)
    let px = a.x - c.x
    let py = a.y - c.y
    let nx = px * co - py * s
    let ny = px * s + py * co
    return FHVec(nx + c.x, ny + c.y)
  }
  @inline(__always) static func lrp(_ a: FHVec, _ b: FHVec, _ t: Double) -> FHVec { add(a, mul(sub(b, a), t)) }
  @inline(__always) static func prj(_ a: FHVec, _ b: FHVec, _ c: Double) -> FHVec { add(a, mul(b, c)) }

  @inline(__always) static func isValidPressure(_ p: Double?) -> Bool {
    guard let p = p else { return false }
    return p >= 0  // false for NaN, like JS
  }

  /// getStroke(points, options)
  static func stroke(_ input: [FHInput], _ o: FreehandOptions) -> [FHVec] {
    return outlinePoints(strokePoints(input, o), o)
  }

  // getStrokePoints.ts
  static func strokePoints(_ input: [FHInput], _ o: FreehandOptions) -> [FHStrokePoint] {
    let streamline = o.streamline
    let size = o.size
    let isComplete = o.last

    if input.isEmpty { return [] }

    let t = MIN_STREAMLINE_T + (1 - streamline) * STREAMLINE_T_RANGE

    var pts = input

    if pts.count == 2 {
      let last = pts[1]
      pts = [pts[0]]
      for i in 1..<5 {
        // lrp returns a 2D vector: the interpolated points carry no pressure.
        let v = lrp(FHVec(pts[0].x, pts[0].y), FHVec(last.x, last.y), Double(i) / 4)
        pts.append(FHInput(x: v.x, y: v.y, pressure: nil))
      }
    }

    if pts.count == 1 {
      let p0 = pts[0]
      pts.append(FHInput(x: p0.x + 1, y: p0.y + 1, pressure: p0.pressure))
    }

    var strokePoints: [FHStrokePoint] = []
    strokePoints.reserveCapacity(pts.count)
    strokePoints.append(FHStrokePoint(
      point: FHVec(pts[0].x, pts[0].y),
      pressure: isValidPressure(pts[0].pressure) ? pts[0].pressure! : DEFAULT_FIRST_PRESSURE,
      vector: FHVec(1, 1),
      distance: 0,
      runningLength: 0
    ))

    var hasReachedMinimumLength = false
    var runningLength = 0.0
    var prev = strokePoints[0]
    let max = pts.count - 1

    for i in 1..<pts.count {
      let raw = FHVec(pts[i].x, pts[i].y)
      let point = (isComplete && i == max) ? raw : lrp(prev.point, raw, t)

      if isEqual(prev.point, point) { continue }

      let distance = dist(point, prev.point)
      runningLength += distance

      if i < max && !hasReachedMinimumLength {
        if runningLength < size { continue }
        hasReachedMinimumLength = true
      }

      prev = FHStrokePoint(
        point: point,
        pressure: isValidPressure(pts[i].pressure) ? pts[i].pressure! : DEFAULT_PRESSURE,
        vector: uni(sub(prev.point, point)),
        distance: distance,
        runningLength: runningLength
      )
      strokePoints.append(prev)
    }

    strokePoints[0].vector = strokePoints.count > 1 ? strokePoints[1].vector : FHVec(0, 0)
    return strokePoints
  }

  @inline(__always) static func strokeRadius(_ size: Double, _ thinning: Double, _ pressure: Double) -> Double {
    return size * (0.5 - thinning * (0.5 - pressure))  // easing = identity
  }

  // getStrokeOutlinePoints.ts (taperStart = taperEnd = 0, capStart = capEnd = true, simulatePressure = false)
  static func outlinePoints(_ points: [FHStrokePoint], _ o: FreehandOptions) -> [FHVec] {
    let size = o.size
    let smoothing = o.smoothing
    let thinning = o.thinning
    let isComplete = o.last

    if points.isEmpty || size <= 0 { return [] }

    let totalLength = points[points.count - 1].runningLength
    let minDistance = pow(size * smoothing, 2)

    var leftPts: [FHVec] = []
    var rightPts: [FHVec] = []
    leftPts.reserveCapacity(points.count + 16)
    rightPts.reserveCapacity(points.count + 16)

    var radius = strokeRadius(size, thinning, points[points.count - 1].pressure)
    var firstRadius: Double? = nil
    var prevVector = points[0].vector
    var prevLeftPoint = points[0].point
    var prevRightPoint = prevLeftPoint
    var tempLeftPoint = prevLeftPoint
    var tempRightPoint = prevRightPoint
    var isPrevPointSharpCorner = false

    for i in 0..<points.count {
      let sp = points[i]
      let pressure = sp.pressure
      let point = sp.point
      let vector = sp.vector
      let runningLength = sp.runningLength
      let isLastPoint = i == points.count - 1

      if !isLastPoint && totalLength - runningLength < END_NOISE_THRESHOLD { continue }

      if thinning != 0 {
        radius = strokeRadius(size, thinning, pressure)
      } else {
        radius = size / 2
      }

      if firstRadius == nil { firstRadius = radius }

      // No taper: both strengths are 1.
      radius = Swift.max(MIN_RADIUS, radius * 1)

      let nextVector = (!isLastPoint ? points[i + 1] : points[i]).vector
      let nextDpr = !isLastPoint ? dpr(vector, nextVector) : 1.0
      let prevDpr = dpr(vector, prevVector)

      let isPointSharpCorner = prevDpr < 0 && !isPrevPointSharpCorner
      let isNextPointSharpCorner = nextDpr < 0

      if isPointSharpCorner || isNextPointSharpCorner {
        let offset = mul(per(prevVector), radius)
        let step = 1 / CORNER_CAP_SEGMENTS
        var t = 0.0
        while t <= 1 {
          tempLeftPoint = rotAround(sub(point, offset), point, FIXED_PI * t)
          leftPts.append(tempLeftPoint)
          tempRightPoint = rotAround(add(point, offset), point, FIXED_PI * -t)
          rightPts.append(tempRightPoint)
          t += step
        }
        prevLeftPoint = tempLeftPoint
        prevRightPoint = tempRightPoint
        if isNextPointSharpCorner { isPrevPointSharpCorner = true }
        continue
      }

      isPrevPointSharpCorner = false

      if isLastPoint {
        let offset = mul(per(vector), radius)
        leftPts.append(sub(point, offset))
        rightPts.append(add(point, offset))
        continue
      }

      let offset = mul(per(lrp(nextVector, vector, nextDpr)), radius)

      tempLeftPoint = sub(point, offset)
      if i <= 1 || dist2(prevLeftPoint, tempLeftPoint) > minDistance {
        leftPts.append(tempLeftPoint)
        prevLeftPoint = tempLeftPoint
      }

      tempRightPoint = add(point, offset)
      if i <= 1 || dist2(prevRightPoint, tempRightPoint) > minDistance {
        rightPts.append(tempRightPoint)
        prevRightPoint = tempRightPoint
      }

      prevVector = vector
    }

    let firstPoint = points[0].point
    let lastPoint = points.count > 1 ? points[points.count - 1].point : add(points[0].point, FHVec(1, 1))

    if points.count == 1 {
      // !(taperStart || taperEnd) is always true here: draw a dot.
      _ = isComplete
      return drawDot(firstPoint, firstRadius ?? radius)
    }

    var startCap: [FHVec] = []
    var endCap: [FHVec] = []

    // Round start cap
    if let r0 = rightPts.first {
      let step = 1 / START_CAP_SEGMENTS
      var t = step
      while t <= 1 {
        startCap.append(rotAround(r0, firstPoint, FIXED_PI * t))
        t += step
      }
    }

    // Round end cap
    let direction = per(neg(points[points.count - 1].vector))
    do {
      let start = prj(lastPoint, direction, radius)
      let step = 1 / END_CAP_SEGMENTS
      var t = step
      while t < 1 {
        endCap.append(rotAround(start, lastPoint, FIXED_PI * 3 * t))
        t += step
      }
    }

    var out = leftPts
    out.reserveCapacity(leftPts.count + endCap.count + rightPts.count + startCap.count)
    out.append(contentsOf: endCap)
    out.append(contentsOf: rightPts.reversed())
    out.append(contentsOf: startCap)
    return out
  }

  static func drawDot(_ center: FHVec, _ radius: Double) -> [FHVec] {
    let offsetPoint = add(center, FHVec(1, 1))
    let start = prj(center, uni(per(sub(center, offsetPoint))), -radius)
    var dotPts: [FHVec] = []
    let step = 1 / START_CAP_SEGMENTS
    var t = step
    while t <= 1 {
      dotPts.append(rotAround(start, center, FIXED_PI * 2 * t))
      t += step
    }
    return dotPts
  }

  /// Closed, smoothed path through an outline, the same construction as perfect-freehand's README
  /// `getSvgPathFromStroke` ("M p0 Q p1 mid(p1,p2) T mid(p2,p3) … Z"). The T segments reflect the previous
  /// control point, which works out to control p[i] and end mid(p[i], p[i+1]).
  /// `sx`/`sy` map page units to view points. Fewer than 4 points gives an empty path, like the JS.
  static func path(from outline: [FHVec], sx: CGFloat, sy: CGFloat) -> CGPath {
    let path = CGMutablePath()
    let n = outline.count
    if n < 4 { return path }
    func pt(_ v: FHVec) -> CGPoint { CGPoint(x: CGFloat(v.x) * sx, y: CGFloat(v.y) * sy) }
    func mid(_ a: FHVec, _ b: FHVec) -> CGPoint {
      CGPoint(x: CGFloat((a.x + b.x) / 2) * sx, y: CGFloat((a.y + b.y) / 2) * sy)
    }
    path.move(to: pt(outline[0]))
    path.addQuadCurve(to: mid(outline[1], outline[2]), control: pt(outline[1]))
    if n - 1 > 2 {
      for i in 2..<(n - 1) {
        path.addQuadCurve(to: mid(outline[i], outline[i + 1]), control: pt(outline[i]))
      }
    }
    path.closeSubpath()
    return path
  }
}
