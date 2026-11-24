package app.qalm.ink

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.round
import kotlin.math.sin

/**
 * Live shapes (hold to snap, drag to adjust): the parts that run on the UI thread. Recognition stays in JS (@qalm/core
 * `recognizeShape`, asked once per hold); this is a port of core's `adjustShape` and `shapePolylines`, so the shape
 * follows the pen without a round trip. Pure Kotlin, tested on the JVM (LiveShapeTest) against the same cases as core.
 */
object LiveShape {
  /** Hold the pen this long (ms) … */
  const val HOLD_MS = 400L
  /** … within this distance (mm) of where the hold began (core: SNAP_HOLD_MS / SNAP_HOLD_TOLERANCE_MM). */
  const val HOLD_MM = 2.5
  private const val AXIS_SNAP_DEG = 5.0
  private const val TURN_SNAP_DEG = 6.0
  private const val DEG = PI / 180

  private val OPEN = setOf("line", "arrow", "double-arrow")

  private fun snapAxis(a: Double, deg: Double = AXIS_SNAP_DEG): Double {
    val q = round(a / (PI / 2)) * (PI / 2)
    return if (abs(a - q) <= deg * DEG) q else a
  }

  /** core `adjustShape`: the shape's new points with the pen at [to], having snapped with the pen at [from]. */
  fun adjust(kind: String, pts: List<DoubleArray>, from: DoubleArray, to: DoubleArray): List<DoubleArray> {
    val copy = pts.map { doubleArrayOf(it[0], it[1]) }
    if (kind in OPEN) {
      if (copy.size < 2) return copy
      val a = copy[0]
      val b = copy[1]
      val moveB = hypot(b[0] - from[0], b[1] - from[1]) <= hypot(a[0] - from[0], a[1] - from[1])
      val fixed = if (moveB) a else b
      val e0 = if (moveB) b else a
      val ex = e0[0] + to[0] - from[0]
      val ey = e0[1] + to[1] - from[1]
      val len = hypot(ex - fixed[0], ey - fixed[1])
      if (len < 1) return copy
      val ang = snapAxis(atan2(ey - fixed[1], ex - fixed[0]))
      val e = doubleArrayOf(fixed[0] + cos(ang) * len, fixed[1] + sin(ang) * len)
      return if (moveB) listOf(fixed, e) else listOf(e, fixed)
    }
    if (copy.isEmpty()) return copy
    val cx = copy.sumOf { it[0] } / copy.size
    val cy = copy.sumOf { it[1] } / copy.size
    val ux = from[0] - cx
    val uy = from[1] - cy
    val vx = to[0] - cx
    val vy = to[1] - cy
    val lu = hypot(ux, uy)
    val lv = hypot(vx, vy)
    if (lu < 1e-6 || lv < 1e-6) return copy
    val k = min(50.0, max(0.05, lv / lu))
    var th = atan2(vy, vx) - atan2(uy, ux)
    th = atan2(sin(th), cos(th))
    if (abs(th) <= TURN_SNAP_DEG * DEG) {
      th = 0.0
    } else if ((kind == "rect" || kind == "ellipse") && copy.size >= 4) {
      val a0 = atan2(copy[1][1] - copy[0][1], copy[1][0] - copy[0][0])
      th = snapAxis(a0 + th, TURN_SNAP_DEG) - a0
    }
    val c = cos(th) * k
    val s = sin(th) * k
    return copy.map {
      val dx = it[0] - cx
      val dy = it[1] - cy
      doubleArrayOf(cx + dx * c - dy * s, cy + dx * s + dy * c)
    }
  }

  /** core `shapePolylines`: the outline to draw (ellipse with 64 segments, arrow heads at most 16 units). */
  fun polylines(kind: String, pts: List<DoubleArray>): List<List<DoubleArray>> {
    if (pts.isEmpty()) return emptyList()
    fun closed() = listOf(pts + listOf(pts[0]))
    return when (kind) {
      "line" -> listOf(pts.take(2))
      "arrow", "double-arrow" -> {
        if (pts.size < 2) return emptyList()
        val tail = pts[0]
        val tip = pts[1]
        val len = min(16.0, hypot(tip[0] - tail[0], tip[1] - tail[1]) * 0.3)
        fun head(f: DoubleArray, t: DoubleArray): List<DoubleArray> {
          val ang = atan2(t[1] - f[1], t[0] - f[0])
          fun barb(da: Double) = doubleArrayOf(t[0] - len * cos(ang + da), t[1] - len * sin(ang + da))
          return listOf(barb(PI / 7), t, barb(-PI / 7))
        }
        if (kind == "arrow") listOf(listOf(tail, tip), head(tail, tip)) else listOf(listOf(tail, tip), head(tail, tip), head(tip, tail))
      }
      "rect" -> if (pts.size == 2) {
        val a = pts[0]
        val b = pts[1]
        listOf(listOf(a, doubleArrayOf(b[0], a[1]), b, doubleArrayOf(a[0], b[1]), a))
      } else closed()
      "ellipse" -> {
        val cx: Double
        val cy: Double
        val u: DoubleArray
        val v: DoubleArray
        if (pts.size >= 4) {
          cx = (pts[0][0] + pts[2][0]) / 2
          cy = (pts[0][1] + pts[2][1]) / 2
          u = doubleArrayOf((pts[1][0] - pts[0][0]) / 2, (pts[1][1] - pts[0][1]) / 2)
          v = doubleArrayOf((pts[3][0] - pts[0][0]) / 2, (pts[3][1] - pts[0][1]) / 2)
        } else {
          val a = pts[0]
          val b = pts.getOrElse(1) { a }
          cx = (a[0] + b[0]) / 2
          cy = (a[1] + b[1]) / 2
          u = doubleArrayOf(abs(b[0] - a[0]) / 2, 0.0)
          v = doubleArrayOf(0.0, abs(b[1] - a[1]) / 2)
        }
        listOf((0..64).map {
          val t = it / 64.0 * 2 * PI
          doubleArrayOf(cx + u[0] * cos(t) + v[0] * sin(t), cy + u[1] * cos(t) + v[1] * sin(t))
        })
      }
      else -> closed() // triangle, diamond, pentagon, hexagon, star
    }
  }
}
