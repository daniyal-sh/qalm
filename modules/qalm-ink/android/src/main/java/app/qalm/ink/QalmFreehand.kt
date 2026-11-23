package app.qalm.ink

import android.graphics.Path
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin

/**
 * Faithful Kotlin port of perfect-freehand 1.2.3 (getStrokePoints + getStrokeOutlinePoints, MIT, Steve Ruiz),
 * restricted to what the tech-spec §2 settings use: no tapers, round caps, linear easing.
 * Same constants, same loops, same float accumulation, so the live stroke matches the Skia one exactly.
 */
object QalmFreehand {
  private const val RATE_OF_PRESSURE_CHANGE = 0.275
  private const val FIXED_PI = PI + 0.0001
  private const val START_CAP_SEGMENTS = 13
  private const val END_CAP_SEGMENTS = 29
  private const val CORNER_CAP_SEGMENTS = 13
  private const val END_NOISE_THRESHOLD = 3.0
  private const val MIN_STREAMLINE_T = 0.15
  private const val STREAMLINE_T_RANGE = 0.85
  private const val MIN_RADIUS = 0.01
  private const val DEFAULT_FIRST_PRESSURE = 0.25
  private const val DEFAULT_PRESSURE = 0.5

  data class Options(
    val size: Double,
    val thinning: Double,
    val smoothing: Double,
    val streamline: Double,
    val simulatePressure: Boolean,
    val last: Boolean,
  )

  /** Tech-spec §2 tilt shading. */
  fun tiltPressure(p: Double, tilt: Double): Double = min(1.0, p * (1 + 0.6 * (1 - tilt / (PI / 2))))

  fun penOptions(width: Double) = Options(width, 0.6, 0.5, 0.35, simulatePressure = false, last = true)
  fun highlighterOptions(width: Double) = Options(width, 0.0, 0.5, 0.5, simulatePressure = false, last = true)

  /** Outline of a stroke in the spec settings for [tool] ("pen" | "highlighter"). Input points are page units. */
  fun outline(tool: String, width: Double, points: List<InkPoint>): List<DoubleArray> =
    if (tool == "highlighter") {
      getStroke(points.map { doubleArrayOf(it.x, it.y, 0.5) }, highlighterOptions(width))
    } else {
      getStroke(points.map { doubleArrayOf(it.x, it.y, tiltPressure(it.p, it.tilt)) }, penOptions(width))
    }

  /**
   * Exactly src/outlinePath.ts `traceOutline` (= @qalm/core `outlineToSvgPath`, iOS `Freehand.path`):
   * M p0, Q p1 mid(p1,p2), then Q p[i] mid(p[i],p[i+1]) for i = 2..n-2, close. Fewer than 4 points: the polygon.
   * Filled non-zero (Path's default WINDING).
   */
  fun toPath(outline: List<DoubleArray>, path: Path = Path()): Path {
    val n = outline.size
    if (n == 0) return path
    path.moveTo(outline[0][0].toFloat(), outline[0][1].toFloat())
    if (n < 4) {
      for (i in 1 until n) path.lineTo(outline[i][0].toFloat(), outline[i][1].toFloat())
      path.close()
      return path
    }
    for (i in 1 until n - 1) {
      val a = outline[i]
      val b = outline[i + 1]
      path.quadTo(a[0].toFloat(), a[1].toFloat(), ((a[0] + b[0]) / 2).toFloat(), ((a[1] + b[1]) / 2).toFloat())
    }
    path.close()
    return path
  }

  fun getStroke(points: List<DoubleArray>, o: Options): List<DoubleArray> =
    getStrokeOutlinePoints(getStrokePoints(points, o), o)

  // ---- vec ----
  private fun add(a: DoubleArray, b: DoubleArray) = doubleArrayOf(a[0] + b[0], a[1] + b[1])
  private fun sub(a: DoubleArray, b: DoubleArray) = doubleArrayOf(a[0] - b[0], a[1] - b[1])
  private fun mul(a: DoubleArray, n: Double) = doubleArrayOf(a[0] * n, a[1] * n)
  private fun div(a: DoubleArray, n: Double) = doubleArrayOf(a[0] / n, a[1] / n)
  private fun per(a: DoubleArray) = doubleArrayOf(a[1], -a[0])
  private fun neg(a: DoubleArray) = doubleArrayOf(-a[0], -a[1])
  private fun dpr(a: DoubleArray, b: DoubleArray) = a[0] * b[0] + a[1] * b[1]
  private fun isEqual(a: DoubleArray, b: DoubleArray) = a[0] == b[0] && a[1] == b[1]
  private fun len(a: DoubleArray) = hypot(a[0], a[1])
  private fun uni(a: DoubleArray) = div(a, len(a))
  private fun dist(a: DoubleArray, b: DoubleArray) = hypot(a[1] - b[1], a[0] - b[0])
  private fun dist2(a: DoubleArray, b: DoubleArray): Double {
    val dx = a[0] - b[0]
    val dy = a[1] - b[1]
    return dx * dx + dy * dy
  }
  private fun lrp(a: DoubleArray, b: DoubleArray, t: Double) = add(a, mul(sub(b, a), t))
  private fun prj(a: DoubleArray, b: DoubleArray, c: Double) = add(a, mul(b, c))
  private fun rotAround(a: DoubleArray, c: DoubleArray, r: Double): DoubleArray {
    val s = sin(r)
    val co = cos(r)
    val px = a[0] - c[0]
    val py = a[1] - c[1]
    val nx = px * co - py * s
    val ny = px * s + py * co
    return doubleArrayOf(nx + c[0], ny + c[1])
  }

  class StrokePoint(
    val point: DoubleArray,
    val pressure: Double,
    var vector: DoubleArray,
    val distance: Double,
    val runningLength: Double,
  )

  private fun validPressure(pt: DoubleArray): Double? =
    if (pt.size > 2 && !pt[2].isNaN() && pt[2] >= 0) pt[2] else null

  fun getStrokePoints(input: List<DoubleArray>, o: Options): List<StrokePoint> {
    if (input.isEmpty()) return emptyList()
    val t = MIN_STREAMLINE_T + (1 - o.streamline) * STREAMLINE_T_RANGE
    var pts: List<DoubleArray> = input

    if (pts.size == 2) {
      val last = pts[1]
      val next = ArrayList<DoubleArray>(5)
      next.add(pts[0])
      // Interpolated points carry no pressure (they get DEFAULT_PRESSURE), as in the original.
      for (i in 1 until 5) next.add(lrp(pts[0], last, i / 4.0))
      pts = next
    }
    if (pts.size == 1) {
      val p0 = pts[0]
      val extra = add(p0, doubleArrayOf(1.0, 1.0))
      pts = listOf(p0, if (p0.size > 2) doubleArrayOf(extra[0], extra[1], p0[2]) else extra)
    }

    val strokePoints = ArrayList<StrokePoint>(pts.size)
    strokePoints.add(
      StrokePoint(
        doubleArrayOf(pts[0][0], pts[0][1]),
        validPressure(pts[0]) ?: DEFAULT_FIRST_PRESSURE,
        doubleArrayOf(1.0, 1.0),
        0.0,
        0.0,
      ),
    )
    var hasReachedMinimumLength = false
    var runningLength = 0.0
    var prev = strokePoints[0]
    val maxI = pts.size - 1

    for (i in 1 until pts.size) {
      val point =
        if (o.last && i == maxI) doubleArrayOf(pts[i][0], pts[i][1])
        else lrp(prev.point, doubleArrayOf(pts[i][0], pts[i][1]), t)
      if (isEqual(prev.point, point)) continue
      val distance = dist(point, prev.point)
      runningLength += distance
      if (i < maxI && !hasReachedMinimumLength) {
        if (runningLength < o.size) continue
        hasReachedMinimumLength = true
      }
      prev = StrokePoint(point, validPressure(pts[i]) ?: DEFAULT_PRESSURE, uni(sub(prev.point, point)), distance, runningLength)
      strokePoints.add(prev)
    }
    strokePoints[0].vector = if (strokePoints.size > 1) strokePoints[1].vector else doubleArrayOf(0.0, 0.0)
    return strokePoints
  }

  private fun simulatePressure(prevPressure: Double, distance: Double, size: Double): Double {
    val sp = min(1.0, distance / size)
    val rp = min(1.0, 1 - sp)
    return min(1.0, prevPressure + (rp - prevPressure) * (sp * RATE_OF_PRESSURE_CHANGE))
  }

  private fun strokeRadius(size: Double, thinning: Double, pressure: Double) = size * (0.5 - thinning * (0.5 - pressure))

  fun getStrokeOutlinePoints(points: List<StrokePoint>, o: Options): List<DoubleArray> {
    val size = o.size
    if (points.isEmpty() || size <= 0) return emptyList()
    val totalLength = points[points.size - 1].runningLength
    val minDistance = (size * o.smoothing).pow(2)
    val leftPts = ArrayList<DoubleArray>()
    val rightPts = ArrayList<DoubleArray>()

    var prevPressure = points[0].pressure
    for (k in 0 until min(10, points.size)) {
      var pressure = points[k].pressure
      if (o.simulatePressure) pressure = simulatePressure(prevPressure, points[k].distance, size)
      prevPressure = (prevPressure + pressure) / 2
    }

    var radius = strokeRadius(size, o.thinning, points[points.size - 1].pressure)
    var firstRadius: Double? = null
    var prevVector = points[0].vector
    var prevLeftPoint = points[0].point
    var prevRightPoint = prevLeftPoint
    var tempLeftPoint = prevLeftPoint
    var tempRightPoint = prevRightPoint
    var isPrevPointSharpCorner = false

    for (i in points.indices) {
      var pressure = points[i].pressure
      val sp = points[i]
      val point = sp.point
      val vector = sp.vector
      val isLastPoint = i == points.size - 1

      if (!isLastPoint && totalLength - sp.runningLength < END_NOISE_THRESHOLD) continue

      if (o.thinning != 0.0) {
        if (o.simulatePressure) pressure = simulatePressure(prevPressure, sp.distance, size)
        radius = strokeRadius(size, o.thinning, pressure)
      } else {
        radius = size / 2
      }
      if (firstRadius == null) firstRadius = radius
      // No tapers in the spec settings: both taper strengths are 1.
      radius = max(MIN_RADIUS, radius * 1.0)

      val nextVector = (if (!isLastPoint) points[i + 1] else points[i]).vector
      val nextDpr = if (!isLastPoint) dpr(vector, nextVector) else 1.0
      val prevDpr = dpr(vector, prevVector)
      val isPointSharpCorner = prevDpr < 0 && !isPrevPointSharpCorner
      val isNextPointSharpCorner = nextDpr < 0

      if (isPointSharpCorner || isNextPointSharpCorner) {
        val offset = mul(per(prevVector), radius)
        val step = 1.0 / CORNER_CAP_SEGMENTS
        var t = 0.0
        while (t <= 1) {
          tempLeftPoint = rotAround(sub(point, offset), point, FIXED_PI * t)
          leftPts.add(tempLeftPoint)
          tempRightPoint = rotAround(add(point, offset), point, FIXED_PI * -t)
          rightPts.add(tempRightPoint)
          t += step
        }
        prevLeftPoint = tempLeftPoint
        prevRightPoint = tempRightPoint
        if (isNextPointSharpCorner) isPrevPointSharpCorner = true
        continue
      }
      isPrevPointSharpCorner = false

      if (isLastPoint) {
        val offset = mul(per(vector), radius)
        leftPts.add(sub(point, offset))
        rightPts.add(add(point, offset))
        continue
      }

      val offset = mul(per(lrp(nextVector, vector, nextDpr)), radius)
      tempLeftPoint = sub(point, offset)
      if (i <= 1 || dist2(prevLeftPoint, tempLeftPoint) > minDistance) {
        leftPts.add(tempLeftPoint)
        prevLeftPoint = tempLeftPoint
      }
      tempRightPoint = add(point, offset)
      if (i <= 1 || dist2(prevRightPoint, tempRightPoint) > minDistance) {
        rightPts.add(tempRightPoint)
        prevRightPoint = tempRightPoint
      }
      prevPressure = pressure
      prevVector = vector
    }

    val firstPoint = doubleArrayOf(points[0].point[0], points[0].point[1])
    val lastPoint =
      if (points.size > 1) doubleArrayOf(points[points.size - 1].point[0], points[points.size - 1].point[1])
      else add(points[0].point, doubleArrayOf(1.0, 1.0))
    val startCap = ArrayList<DoubleArray>()
    val endCap = ArrayList<DoubleArray>()

    if (points.size == 1) {
      // No tapers, so a single point is always a dot.
      return drawDot(firstPoint, firstRadius ?: radius)
    } else {
      if (rightPts.isNotEmpty()) {
        val step = 1.0 / START_CAP_SEGMENTS
        var t = step
        while (t <= 1) {
          startCap.add(rotAround(rightPts[0], firstPoint, FIXED_PI * t))
          t += step
        }
      }
      val direction = per(neg(points[points.size - 1].vector))
      val start = prj(lastPoint, direction, radius)
      val step = 1.0 / END_CAP_SEGMENTS
      var t = step
      while (t < 1) {
        endCap.add(rotAround(start, lastPoint, FIXED_PI * 3 * t))
        t += step
      }
    }

    val out = ArrayList<DoubleArray>(leftPts.size + endCap.size + rightPts.size + startCap.size)
    out.addAll(leftPts)
    out.addAll(endCap)
    out.addAll(rightPts.asReversed())
    out.addAll(startCap)
    return out
  }

  private fun drawDot(center: DoubleArray, radius: Double): List<DoubleArray> {
    val offsetPoint = add(center, doubleArrayOf(1.0, 1.0))
    val start = prj(center, uni(per(sub(center, offsetPoint))), -radius)
    val pts = ArrayList<DoubleArray>()
    val step = 1.0 / START_CAP_SEGMENTS
    var t = step
    while (t <= 1) {
      pts.add(rotAround(start, center, FIXED_PI * 2 * t))
      t += step
    }
    return pts
  }
}

/** Page-unit input point; same fields as InkPoint in @qalm/core. */
data class InkPoint(val x: Double, val y: Double, val p: Double, val tilt: Double, val az: Double, val t: Double)
