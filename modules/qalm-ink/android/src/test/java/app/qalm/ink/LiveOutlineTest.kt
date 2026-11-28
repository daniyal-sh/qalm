package app.qalm.ink

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin
import kotlin.random.Random

/** LiveOutline must give exactly QalmFreehand.outline (the reference) on every sample of a stroke. */
class LiveOutlineTest {
  private class Setup(val tool: String, val width: Double, val style: String, val smoothing: Int)

  private val setups = buildList {
    for (style in listOf("fountain", "ball", "brush")) for (sm in 0..3) for (w in listOf(0.6, 2.0, 7.0)) add(Setup("pen", w, style, sm))
    for (w in listOf(4.0, 12.0)) add(Setup("highlighter", w, "fountain", 0))
  }

  /**
   * A handwriting-like random walk in page units: varying speed, pauses (repeated and tiny moves), sharp reversals,
   * loops, and pressure / tilt changes.
   */
  private fun stroke(rnd: Random, n: Int): List<InkPoint> {
    val pts = ArrayList<InkPoint>(n)
    var x = rnd.nextDouble(50.0, 500.0)
    var y = rnd.nextDouble(50.0, 700.0)
    var a = rnd.nextDouble(0.0, 2 * PI)
    var p = rnd.nextDouble(0.1, 0.9)
    var tilt = rnd.nextDouble(0.3, PI / 2)
    for (i in 0 until n) {
      pts.add(InkPoint(x, y, p, tilt, 0.0, i * 4.0))
      when (rnd.nextInt(20)) {
        0 -> {} // the same point again
        1 -> { x += rnd.nextDouble(-0.05, 0.05); y += rnd.nextDouble(-0.05, 0.05) } // below every minStep
        2 -> a += PI + rnd.nextDouble(-0.3, 0.3) // a sharp reversal
        else -> {
          a += rnd.nextDouble(-0.5, 0.5)
          val v = if (rnd.nextInt(8) == 0) rnd.nextDouble(2.0, 8.0) else rnd.nextDouble(0.05, 1.5)
          x += cos(a) * v
          y += sin(a) * v
        }
      }
      p = (p + rnd.nextDouble(-0.06, 0.06)).coerceIn(0.0, 1.0)
      tilt = (tilt + rnd.nextDouble(-0.05, 0.05)).coerceIn(0.0, PI / 2)
    }
    return pts
  }

  /** Up to 3 guessed points ahead, at the last real pressure and tilt (as QalmInkView makes them). */
  private fun predicted(rnd: Random, real: List<InkPoint>): List<InkPoint> {
    val last = real.last()
    val k = rnd.nextInt(4)
    val dx = rnd.nextDouble(-2.0, 2.0)
    val dy = rnd.nextDouble(-2.0, 2.0)
    return (1..k).map { last.copy(x = last.x + dx * it, y = last.y + dy * it) }
  }

  private fun assertSame(what: String, want: List<DoubleArray>, got: List<DoubleArray>) {
    assertEquals("$what: length", want.size, got.size)
    for (i in want.indices) assertTrue("$what [$i]: ${want[i].toList()} vs ${got[i].toList()}", want[i].contentEquals(got[i]))
  }

  private fun check(s: Setup, pts: List<InkPoint>, rnd: Random?, name: String) {
    val live = LiveOutline(s.tool, s.width, s.style, s.smoothing)
    for (n in 1..pts.size) {
      val real = pts.subList(0, n)
      val pred = if (rnd != null) predicted(rnd, real) else emptyList()
      val want = QalmFreehand.outline(s.tool, s.width, real + pred, s.style, s.smoothing)
      assertSame("$name ${s.tool}/${s.style}/${s.smoothing}/${s.width} n=$n +${pred.size}", want, live.outline(real, pred))
    }
    // The finished stroke (no predicted points) is exactly what PageCanvas draws.
    assertSame("$name end", QalmFreehand.outline(s.tool, s.width, pts, s.style, s.smoothing), live.outline(pts, emptyList()))
  }

  @Test
  fun matchesReferenceEverySample() {
    val rnd = Random(79)
    for (s in setups) {
      for (k in 0 until 6) {
        val pts = stroke(rnd, if (k == 0) 12 else rnd.nextInt(20, 220))
        check(s, pts, null, "stroke $k")
        check(s, pts, Random(k), "stroke $k predicted")
      }
    }
  }

  @Test
  fun shortAndDegenerateStrokes() {
    val rnd = Random(3)
    val still = List(30) { InkPoint(100.0, 100.0, 0.5, 1.0, 0.0, it.toDouble()) }
    val jitter = List(40) { InkPoint(100.0 + (it % 3) * 0.01, 100.0, 0.5, 1.0, 0.0, it.toDouble()) }
    val line = List(40) { InkPoint(100.0 + it * 0.4, 100.0, 0.7, 1.0, 0.0, it.toDouble()) }
    val zigzag = List(60) { InkPoint(100.0 + it * 0.5, 100.0 + (if (it % 2 == 0) 0.0 else 3.0), 0.6, 1.0, 0.0, it.toDouble()) }
    for (s in setups) {
      for ((name, pts) in listOf("still" to still, "jitter" to jitter, "line" to line, "zigzag" to zigzag)) {
        check(s, pts, null, name)
        check(s, pts, rnd, "$name predicted")
      }
    }
  }

  /**
   * Per-sample time of the reference (whole stroke every sample) and LiveOutline, at 500 and 2000 points. Prints
   * the numbers (see build/test-results); asserts only that the incremental one is clearly faster on long strokes.
   */
  @Test
  fun timing() {
    val rnd = Random(500)
    for (n in listOf(500, 2000)) {
      val pts = stroke(rnd, n)
      val tail = 200 // time the last 200 samples
      fun run(incremental: Boolean): Double {
        var best = Double.MAX_VALUE
        repeat(5) {
          val live = LiveOutline("pen", 2.0, "fountain", 2)
          val pr = Random(1)
          var ns = 0L
          for (k in 1..n) {
            val real = pts.subList(0, k)
            val pred = predicted(pr, real)
            val t0 = System.nanoTime()
            val out = if (incremental) live.outline(real, pred) else QalmFreehand.outline("pen", 2.0, real + pred, "fountain", 2)
            if (k > n - tail) ns += System.nanoTime() - t0
            if (out.isEmpty()) error("empty")
          }
          best = minOf(best, ns / tail / 1000.0)
        }
        return best
      }
      val before = run(false)
      val after = run(true)
      println("LiveOutline timing: $n points, per sample: reference ${"%.1f".format(before)} µs, incremental ${"%.1f".format(after)} µs")
      if (n >= 2000) assertTrue("incremental $after µs vs reference $before µs", after * 4 < before)
    }
  }
}
