package app.qalm.ink

import kotlin.math.max
import kotlin.math.min

/**
 * Exactly `changedBounds` in src/inkDamage.ts: where two outlines of the same stroke differ (traced as in
 * [QalmFreehand.toPath], filled non-zero). Returns [minX, minY, maxX, maxY] in outline units, or null when they
 * are the same. The front-buffered overlay clears and redraws only this box. Clearing the whole front buffer on
 * every sample made the tip tear and flicker while the display read it.
 */
object InkDamage {
  fun changedBounds(prev: List<DoubleArray>, cur: List<DoubleArray>): DoubleArray? {
    val a = prev.size
    val b = cur.size
    val m = min(a, b)
    fun same(i: Int, j: Int) = prev[i][0] == cur[j][0] && prev[i][1] == cur[j][1]
    var head = 0
    while (head < m && same(head, head)) head++
    if (head == a && a == b) return null
    var tail = 0
    while (tail < m - head && same(a - 1 - tail, b - 1 - tail)) tail++
    val lo = head - 2
    val hiA = a - tail + 1
    val hiB = b - tail + 1
    val box = doubleArrayOf(Double.POSITIVE_INFINITY, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY, Double.NEGATIVE_INFINITY)
    fun grow(pts: List<DoubleArray>, from: Int, to: Int) {
      for (i in from..to) {
        val x = pts[i][0]
        val y = pts[i][1]
        box[0] = min(box[0], x)
        box[1] = min(box[1], y)
        box[2] = max(box[2], x)
        box[3] = max(box[3], y)
      }
    }
    // The change reaches the first or last point (the closing line), or a polygon too short to curve: all of both.
    if (lo <= 0 || hiA >= a - 1 || hiB >= b - 1 || a < 4 || b < 4) {
      grow(prev, 0, a - 1)
      grow(cur, 0, b - 1)
    } else {
      grow(prev, lo, hiA)
      grow(cur, lo, hiB)
    }
    return if (box[0] <= box[2]) box else null
  }
}
