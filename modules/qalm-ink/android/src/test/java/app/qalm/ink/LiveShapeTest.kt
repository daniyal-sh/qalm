package app.qalm.ink

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.sin

/** The port of @qalm/core `adjustShape` / `shapePolylines`: the same cases as core's liveShapes.test.ts. */
class LiveShapeTest {
  private fun p(x: Double, y: Double) = doubleArrayOf(x, y)
  private fun len(a: DoubleArray, b: DoubleArray) = hypot(b[0] - a[0], b[1] - a[1])
  private val eps = 1e-6

  @Test fun holdConstantsMatchCore() {
    assertEquals(400L, LiveShape.HOLD_MS)
    assertEquals(2.5, LiveShape.HOLD_MM, 0.0)
  }

  @Test fun lineEndFollowsThePen() {
    val out = LiveShape.adjust("line", listOf(p(100.0, 100.0), p(200.0, 130.0)), p(200.0, 130.0), p(300.0, 200.0))
    assertEquals(100.0, out[0][0], eps)
    assertEquals(100.0, out[0][1], eps)
    assertEquals(300.0, out[1][0], eps)
    assertEquals(200.0, out[1][1], eps)
    // The pen near the first end moves that one, by the pen's offset.
    val back = LiveShape.adjust("line", listOf(p(100.0, 100.0), p(200.0, 130.0)), p(102.0, 99.0), p(50.0, 50.0))
    assertEquals(200.0, back[1][0], eps)
    assertEquals(48.0, back[0][0], eps)
    assertEquals(51.0, back[0][1], eps)
  }

  @Test fun lineSnapsToTheAxes() {
    val s = listOf(p(100.0, 100.0), p(200.0, 100.0))
    val h = LiveShape.adjust("line", s, p(200.0, 100.0), p(300.0, 106.0))
    assertEquals(100.0, h[1][1], eps)
    assertEquals(100 + hypot(200.0, 6.0), h[1][0], eps)
    val v = LiveShape.adjust("arrow", s, p(200.0, 100.0), p(108.0, 250.0))
    assertEquals(100.0, v[1][0], eps)
    val d = LiveShape.adjust("line", s, p(200.0, 100.0), p(200.0, 200.0))
    assertEquals(200.0, d[1][0], eps)
    assertEquals(200.0, d[1][1], eps)
  }

  @Test fun closedShapesScaleAndTurnAboutTheirCentre() {
    val sq = listOf(p(100.0, 100.0), p(200.0, 100.0), p(200.0, 200.0), p(100.0, 200.0))
    val small = LiveShape.adjust("rect", sq, p(200.0, 200.0), p(262.0, 268.0)) // ~2.6°: stays upright
    assertEquals(small[0][1], small[1][1], eps)
    assertEquals(len(small[0], small[1]), len(small[1], small[2]), eps)
    assertTrue(len(small[0], small[1]) > 125)
    val big = LiveShape.adjust("rect", sq, p(200.0, 200.0), p(150.0, 150 + 50 * kotlin.math.sqrt(2.0)))
    assertEquals(45.0, atan2(big[1][1] - big[0][1], big[1][0] - big[0][0]) * 180 / PI, 1e-4)
    assertEquals(100.0, len(big[0], big[1]), 1e-4)
    val same = LiveShape.adjust("rect", sq, p(200.0, 200.0), p(200.0, 200.0))
    for (i in 0..3) assertTrue(sq[i].contentEquals(same[i]))
  }

  @Test fun turnedRectangleComesUpright() {
    val a = 20 * PI / 180
    fun rot(x: Double, y: Double, t: Double) = p(300 + x * cos(t) - y * sin(t), 400 + x * sin(t) + y * cos(t))
    val r = listOf(rot(-60.0, -30.0, a), rot(60.0, -30.0, a), rot(60.0, 30.0, a), rot(-60.0, 30.0, a))
    val from = r[2]
    val to = rot(from[0] - 300, from[1] - 400, -17 * PI / 180)
    val out = LiveShape.adjust("rect", r, from, to)
    assertEquals(out[0][1], out[1][1], eps)
  }

  @Test fun outlines() {
    val arrow = LiveShape.polylines("arrow", listOf(p(0.0, 0.0), p(100.0, 0.0)))
    assertEquals(2, arrow.size)
    assertEquals(16.0, len(arrow[1][0], arrow[1][1]), eps) // head capped at 16 units
    assertEquals(3, LiveShape.polylines("double-arrow", listOf(p(0.0, 0.0), p(100.0, 0.0))).size)
    val ell = LiveShape.polylines("ellipse", listOf(p(0.0, 0.0), p(100.0, 0.0), p(100.0, 50.0), p(0.0, 50.0)))[0]
    assertEquals(65, ell.size)
    assertEquals(100.0, ell[0][0], eps)
    assertEquals(25.0, ell[0][1], eps)
    val tri = LiveShape.polylines("triangle", listOf(p(0.0, 0.0), p(10.0, 0.0), p(5.0, 8.0)))[0]
    assertEquals(4, tri.size)
    assertTrue(tri[0].contentEquals(tri[3]))
  }
}
