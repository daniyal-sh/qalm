package app.qalm.ink

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import kotlin.math.PI
import kotlin.math.atan2
import kotlin.math.hypot

/** The port of @qalm/core's ruler geometry: the same cases as core's ruler.test.ts. */
class RulerSnapTest {
  private fun deg(d: Double) = d * PI / 180
  private fun pose(angle: Double = 0.0) = RulerSnap.Pose(400.0, 300.0, angle, 600.0, 60.0)
  private val eps = 1e-6

  @Test fun snapZoneMatchesCore() = assertEquals(24.0, RulerSnap.SNAP_DP, 0.0)

  @Test fun topAndBottomEdges() {
    val (top, bottom) = RulerSnap.edges(pose())
    assertEquals(100.0, top.ax, eps)
    assertEquals(270.0, top.ay, eps)
    assertEquals(700.0, top.bx, eps)
    assertEquals(-1.0, top.ny, eps)
    assertEquals(330.0, bottom.ay, eps)
    assertEquals(1.0, bottom.ny, eps)
  }

  @Test fun startNearAnEdgeSnapsToIt() {
    val r = pose()
    assertEquals(270.0, RulerSnap.edgeAt(r, 400.0, 255.0)!!.ay, eps) // 15 above the top edge
    assertEquals(270.0, RulerSnap.edgeAt(r, 400.0, 290.0)!!.ay, eps) // over the top half
    assertEquals(330.0, RulerSnap.edgeAt(r, 400.0, 345.0)!!.ay, eps) // below the bottom edge
    assertNull(RulerSnap.edgeAt(r, 400.0, 200.0)) // too far
    assertNull(RulerSnap.edgeAt(r, 760.0, 260.0)) // beyond its end
    assertNotNull(RulerSnap.edgeAt(r, 715.0, 260.0)) // just past the end
  }

  @Test fun turnedNinetyDegrees() {
    val e = RulerSnap.edgeAt(pose(deg(90.0)), 440.0, 300.0)!!
    assertEquals(430.0, e.ax, eps)
    assertEquals(430.0, e.bx, eps)
  }

  @Test fun projectsOntoTheLine() {
    val p = RulerSnap.project(5.0, 9.0, 0.0, 0.0, 10.0, 0.0)
    assertEquals(5.0, p[0], eps)
    assertEquals(0.0, p[1], eps)
  }

  @Test fun lineIsTheEdgePushedOutByHalfThePen() {
    // A page drawn at 2 dp per unit with its top-left at window (100, 50).
    val toPage = { x: Double, y: Double -> doubleArrayOf((x - 100) / 2, (y - 50) / 2) }
    val e = RulerSnap.edgeAt(pose(deg(45.0)), 420.0, 280.0)!!
    val l = RulerSnap.line(e, toPage, 1.0)
    val ea = toPage(e.ax, e.ay)
    val eb = toPage(e.bx, e.by)
    assertEquals(atan2(eb[1] - ea[1], eb[0] - ea[0]), atan2(l[3] - l[1], l[2] - l[0]), eps)
    val c = toPage(400.0, 300.0)
    fun dist(ax: Double, ay: Double, bx: Double, by: Double): Double {
      val q = RulerSnap.project(c[0], c[1], ax, ay, bx, by)
      return hypot(c[0] - q[0], c[1] - q[1])
    }
    assertEquals(1.0, dist(l[0], l[1], l[2], l[3]) - dist(ea[0], ea[1], eb[0], eb[1]), eps)
  }

  @Test fun theLaserNeverErases() {
    assertEquals("laser", Laser.toolFor("laser", eraserHeld = true))
    assertEquals("eraser", Laser.toolFor("pen", eraserHeld = true))
    assertEquals("pen", Laser.toolFor("pen", eraserHeld = false))
  }

  @Test fun laserTrailFades() {
    val pts = mutableListOf(Laser.Pt(0f, 0f, 0L, true), Laser.Pt(1f, 0f, 500L, false), Laser.Pt(2f, 0f, 900L, false))
    assertEquals(1f, Laser.alpha(0L), 0f)
    assertEquals(0.5f, Laser.alpha(500L), 1e-6f)
    assertEquals(0f, Laser.alpha(1500L), 0f)
    Laser.prune(pts, 1200L)
    assertEquals(2, pts.size) // the first point is 1200 ms old
    Laser.prune(pts, 2000L)
    assertEquals(0, pts.size)
  }
}
