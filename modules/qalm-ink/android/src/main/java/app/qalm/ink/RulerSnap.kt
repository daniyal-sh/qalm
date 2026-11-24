package app.qalm.ink

import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.sin

/**
 * The ruler (tech-spec §7, Ruler): a port of @qalm/core `rulerEdges` / `rulerEdgeAt` / `projectOnLine`. The pose is in
 * window dp (React Native's measureInWindow units): centre, angle (radians, clockwise), length and thickness. A pen
 * or highlighter stroke that starts within [SNAP_DP] outside a long edge (or over the ruler's half next to it) is drawn
 * along that edge: every point is projected onto the edge line, pushed out by half the pen width.
 */
object RulerSnap {
  /** InkOverlay.types RULER_SNAP_PX (core RULER.snapPx). */
  const val SNAP_DP = 24.0

  class Pose(val cx: Double, val cy: Double, val angle: Double, val length: Double, val thickness: Double)

  /** One long edge from (ax, ay) to (bx, by), with (nx, ny) its outward unit normal. */
  class Edge(val ax: Double, val ay: Double, val bx: Double, val by: Double, val nx: Double, val ny: Double)

  /** The two long edges: the "top" one (at angle 0, the upper edge) first. */
  fun edges(r: Pose): Pair<Edge, Edge> {
    val ux = cos(r.angle)
    val uy = sin(r.angle)
    val nx = sin(r.angle)
    val ny = -cos(r.angle)
    val hl = r.length / 2
    val ht = r.thickness / 2
    fun edge(s: Double): Edge {
      val ox = r.cx + nx * ht * s
      val oy = r.cy + ny * ht * s
      return Edge(ox - ux * hl, oy - uy * hl, ox + ux * hl, oy + uy * hl, nx * s, ny * s)
    }
    return Pair(edge(1.0), edge(-1.0))
  }

  /** The edge a stroke starting at (x, y) snaps to, or null. */
  fun edgeAt(r: Pose, x: Double, y: Double, zone: Double = SNAP_DP): Edge? {
    val ux = cos(r.angle)
    val uy = sin(r.angle)
    val dx = x - r.cx
    val dy = y - r.cy
    if (abs(dx * ux + dy * uy) > r.length / 2 + zone) return null
    val (e0, e1) = edges(r)
    val across = dx * e0.nx + dy * e0.ny
    val ht = r.thickness / 2
    if (across >= 0 && across <= ht + zone) return e0
    if (across < 0 && -across <= ht + zone) return e1
    return null
  }

  /** (px, py) projected onto the infinite line through (ax, ay) and (bx, by). */
  fun project(px: Double, py: Double, ax: Double, ay: Double, bx: Double, by: Double): DoubleArray {
    val dx = bx - ax
    val dy = by - ay
    val len2 = dx * dx + dy * dy
    if (len2 == 0.0) return doubleArrayOf(ax, ay)
    val t = ((px - ax) * dx + (py - ay) * dy) / len2
    return doubleArrayOf(ax + dx * t, ay + dy * t)
  }

  /**
   * The line a stroke follows, in page units: the edge mapped by [toPage] (window dp → page units, a scale and an
   * offset), pushed out by [offset] page units (half the pen width). Returns ax, ay, bx, by.
   */
  fun line(e: Edge, toPage: (Double, Double) -> DoubleArray, offset: Double): DoubleArray {
    val a = toPage(e.ax, e.ay)
    val b = toPage(e.bx, e.by)
    val n0 = toPage(e.ax + e.nx, e.ay + e.ny)
    var nx = n0[0] - a[0]
    var ny = n0[1] - a[1]
    val l = kotlin.math.hypot(nx, ny).takeIf { it > 0 } ?: 1.0
    nx /= l
    ny /= l
    return doubleArrayOf(a[0] + nx * offset, a[1] + ny * offset, b[0] + nx * offset, b[1] + ny * offset)
  }
}

/** The laser pointer (InkOverlay.types LASER_*): its trail fades over [FADE_MS] and is never saved. */
object Laser {
  const val FADE_MS = 1000L

  /** A trail point: page units, uptime ms, and whether it starts a new segment. */
  class Pt(val x: Float, val y: Float, val t: Long, val start: Boolean)

  /** Drops points FADE_MS old at [now] (from the trail's tail; a segment is drawn from each point to the next). */
  fun prune(pts: MutableList<Pt>, now: Long) {
    var i = 0
    while (i < pts.size && now - pts[i].t >= FADE_MS) i++
    if (i > 0) pts.subList(0, i).clear()
  }

  /**
   * The tool a stroke uses: the barrel button or the eraser end erases that stroke, except with the laser (pointing
   * never changes the page).
   */
  fun toolFor(tool: String, eraserHeld: Boolean): String = if (eraserHeld && tool != "laser") "eraser" else tool

  /** The fade in this many steps: each step of a trail is drawn as one path (InkOverlay laser.ts LASER_BANDS). */
  const val BANDS = 8

  /**
   * The trail as runs to draw, oldest first: consecutive points of one press whose fade (by the newer point's age at
   * [now]) falls in the same band; neighbouring runs share their joint point. Port of laser.ts `laserRuns`.
   */
  fun runs(pts: List<Pt>, now: Long): List<Pair<List<Pt>, Float>> {
    val out = ArrayList<Pair<ArrayList<Pt>, Float>>()
    var cur: Pair<ArrayList<Pt>, Float>? = null
    for (i in 1 until pts.size) {
      val q = pts[i]
      if (q.start) {
        cur = null
        continue
      }
      val band = kotlin.math.ceil(alpha(now - q.t) * BANDS) / BANDS
      if (band <= 0f) continue
      if (cur == null || cur.second != band) {
        cur = Pair(arrayListOf(pts[i - 1]), band)
        out.add(cur)
      }
      cur.first.add(q)
    }
    return out
  }

  /** 1 when new, 0 at FADE_MS. */
  fun alpha(age: Long): Float = (1f - age.toFloat() / FADE_MS).coerceIn(0f, 1f)
}
