package app.qalm.ink

import app.qalm.ink.QalmFreehand.StrokePoint
import kotlin.math.max
import kotlin.math.pow

/**
 * The live stroke's outline, bit-identical to [QalmFreehand.outline] on (real + predicted) points, but computed
 * incrementally: each stage keeps the prefix of its output that no later point can change, with the loop state at
 * its end, and every call reruns the loops only from there. Per sample that is the tail of the stroke, not all of it
 * (plus copying the cached prefix into the returned list).
 *
 * What is final, stage by stage (R real points; the predicted ones and the last real point are never final):
 * - stabilize's minStep filter: decisions on points 1..R-2 (they are interior in every later call; the last point
 *   is always kept as it is). Each [1 2 1] pass is final up to one point less than its input.
 * - getStrokePoints: the streamline lerp and the minimum-length skip are sequential, so its state is saved after the
 *   last final input. That input is never the last one, so `last = true` pinning never applies to it.
 * - getStrokeOutlinePoints: point i is final once point i+1 is (its next vector, sharp corners) and it is at least
 *   END_NOISE_THRESHOLD before the end of the final stroke points (a later total length is never shorter than that).
 * - Strokes too short for the general loops (the 1- and 2-point cases) just run the reference.
 *
 * Only for the settings [QalmFreehand.outline] uses (no simulated pressure, no tapers). Not thread-safe: UI thread.
 */
class LiveOutline(private val tool: String, private val width: Double, private val style: String = "fountain", private val smoothing: Int = 0) {
  private val hl = tool == "highlighter"
  private val curve = (QalmFreehand.PEN_STYLES[style] ?: QalmFreehand.PEN_STYLES.getValue("fountain")).curve
  private val level = if (hl) QalmFreehand.SMOOTHING[0] else QalmFreehand.SMOOTHING.getOrNull(smoothing) ?: QalmFreehand.SMOOTHING[0]
  private val minStep = level.minStep
  private val min2 = minStep * minStep
  private val passes = level.passes
  private val o = if (hl) QalmFreehand.highlighterOptions(width) else QalmFreehand.penOptions(width, style, smoothing)
  private val t = QalmFreehand.MIN_STREAMLINE_T + (1 - o.streamline) * QalmFreehand.STREAMLINE_T_RANGE
  private val minDistance = (o.size * o.smoothing).pow(2)

  /** Mapped input (x, y, pressure) of the real points. */
  private val xs = ArrayList<DoubleArray>()
  /** stabilize: the final kept points, and the last input index decided. */
  private val kept = ArrayList<DoubleArray>()
  private var filtered = 0
  /** The final prefix of each smoothing pass. */
  private val passOut = List(passes) { ArrayList<DoubleArray>() }
  /** getStrokePoints: final stroke points, the inputs they used, and the loop state after them. */
  private val sps = ArrayList<StrokePoint>()
  private var cUsed = 0
  private var cRun = 0.0
  private var cReached = false
  /** getStrokeOutlinePoints: final left / right points, the stroke points they used, and the loop state after them. */
  private val left = ArrayList<DoubleArray>()
  private val right = ArrayList<DoubleArray>()
  private var dUsed = 0
  private var dState: DState? = null

  private class DState(
    var prevVector: DoubleArray,
    var prevLeft: DoubleArray,
    var prevRight: DoubleArray,
    var tempLeft: DoubleArray,
    var tempRight: DoubleArray,
    var prevSharp: Boolean,
    var radius: Double,
  ) {
    fun copy() = DState(prevVector, prevLeft, prevRight, tempLeft, tempRight, prevSharp, radius)
  }

  /** Two lists read as one (no copy). */
  private class Joined<T>(val a: List<T>, val b: List<T>) : AbstractList<T>() {
    override val size get() = a.size + b.size
    override fun get(index: Int): T = if (index < a.size) a[index] else b[index - a.size]
  }

  private fun triple(p: InkPoint): DoubleArray {
    if (hl) return doubleArrayOf(p.x, p.y, 0.5)
    val pr = QalmFreehand.tiltPressure(p.p, p.tilt)
    return doubleArrayOf(p.x, p.y, if (curve == 1.0) pr else pr.pow(curve))
  }

  /** [QalmFreehand.outline] of [real] + [predicted]. [real] only grows between calls (the same stroke). */
  fun outline(real: List<InkPoint>, predicted: List<InkPoint>): List<DoubleArray> {
    while (xs.size < real.size) xs.add(triple(real[xs.size]))
    val all: List<DoubleArray> = Joined(xs, predicted.map(::triple))
    val n = all.size
    if (n == 0 || o.size <= 0) return emptyList()
    if (n < 3 || xs.isEmpty()) return QalmFreehand.getStroke(QalmFreehand.stabilize(all.toList(), minStep, passes), o)
    advance()

    // stabilize, from the final prefix
    val tailA = ArrayList<DoubleArray>()
    var lastKept = kept[kept.size - 1]
    for (i in max(1, filtered + 1)..n - 2) {
      val b = all[i]
      if (minStep > 0) {
        val dx = b[0] - lastKept[0]
        val dy = b[1] - lastKept[1]
        if (dx * dx + dy * dy < min2) continue
      }
      tailA.add(b)
      lastKept = b
    }
    tailA.add(all[n - 1])
    var s: List<DoubleArray> = Joined(kept, tailA)
    val m = s.size
    if (m < 3) return QalmFreehand.getStroke(s.toList(), o) // stabilize skips its passes, getStrokePoints its loop
    for (k in 0 until passes) {
      val fin = passOut[k]
      val prev = s
      val tail = ArrayList<DoubleArray>(m - fin.size)
      for (j in fin.size..m - 2) tail.add(avg(prev[j - 1], prev[j], prev[j + 1]))
      tail.add(prev[m - 1])
      s = Joined(fin, tail)
    }

    // getStrokePoints
    val spTail = ArrayList<StrokePoint>()
    var prev = sps[sps.size - 1]
    var run = cRun
    var reached = cReached
    for (i in cUsed until m) {
      val sp = strokePoint(prev, s[i], run, reached, i < m - 1) ?: continue
      if (sp.distance < 0) { // skipped below the minimum length: the length still counts
        run = sp.runningLength
        continue
      }
      run = sp.runningLength
      reached = reached || i < m - 1
      spTail.add(sp)
      prev = sp
    }
    val pts: List<StrokePoint> = Joined(sps, spTail)
    if (pts.size == 1) {
      sps[0].vector = doubleArrayOf(0.0, 0.0)
      return QalmFreehand.getStrokeOutlinePoints(pts.toList(), o) // a dot
    }
    sps[0].vector = pts[1].vector

    // getStrokeOutlinePoints
    val st = dState?.copy() ?: initD(pts)
    val total = pts[pts.size - 1].runningLength
    val lt = ArrayList<DoubleArray>()
    val rt = ArrayList<DoubleArray>()
    for (i in dUsed until pts.size) outlineStep(st, pts, i, total, lt, rt)

    val firstPoint = doubleArrayOf(pts[0].point[0], pts[0].point[1])
    val lastSp = pts[pts.size - 1]
    val lastPoint = doubleArrayOf(lastSp.point[0], lastSp.point[1])
    val startCap = ArrayList<DoubleArray>()
    val r0 = if (right.isNotEmpty()) right[0] else rt.firstOrNull()
    if (r0 != null) {
      val step = 1.0 / QalmFreehand.START_CAP_SEGMENTS
      var tt = step
      while (tt <= 1) {
        startCap.add(QalmFreehand.rotAround(r0, firstPoint, QalmFreehand.FIXED_PI * tt))
        tt += step
      }
    }
    val endCap = ArrayList<DoubleArray>()
    val direction = QalmFreehand.per(QalmFreehand.neg(lastSp.vector))
    val start = QalmFreehand.prj(lastPoint, direction, st.radius)
    val step = 1.0 / QalmFreehand.END_CAP_SEGMENTS
    var tt = step
    while (tt < 1) {
      endCap.add(QalmFreehand.rotAround(start, lastPoint, QalmFreehand.FIXED_PI * 3 * tt))
      tt += step
    }

    val out = ArrayList<DoubleArray>(left.size + lt.size + endCap.size + rt.size + right.size + startCap.size)
    out.addAll(left)
    out.addAll(lt)
    out.addAll(endCap)
    for (i in rt.indices.reversed()) out.add(rt[i])
    for (i in right.indices.reversed()) out.add(right[i])
    out.addAll(startCap)
    return out
  }

  /** Extends every stage's final prefix to what the real points so far fix. */
  private fun advance() {
    val r = xs.size
    if (kept.isEmpty()) kept.add(xs[0])
    while (filtered + 1 <= r - 2) {
      val b = xs[++filtered]
      val a = kept[kept.size - 1]
      val dx = b[0] - a[0]
      val dy = b[1] - a[1]
      if (minStep <= 0 || dx * dx + dy * dy >= min2) kept.add(b)
    }
    var prev: List<DoubleArray> = kept
    for (k in 0 until passes) {
      val fin = passOut[k]
      val target = max(1, prev.size - 1)
      while (fin.size < target) {
        val j = fin.size
        fin.add(if (j == 0) prev[0] else avg(prev[j - 1], prev[j], prev[j + 1]))
      }
      prev = fin
    }
    if (sps.isEmpty()) {
      val p0 = prev[0]
      sps.add(StrokePoint(doubleArrayOf(p0[0], p0[1]), QalmFreehand.validPressure(p0) ?: QalmFreehand.DEFAULT_FIRST_PRESSURE, doubleArrayOf(1.0, 1.0), 0.0, 0.0))
      cUsed = 1
    }
    while (cUsed < prev.size) {
      // Never the last input (that one stays out of the final prefix), so neither pinned nor exempt from the minimum.
      val sp = strokePoint(sps[sps.size - 1], prev[cUsed], cRun, cReached, true)
      cUsed++
      if (sp == null) continue
      cRun = sp.runningLength
      if (sp.distance < 0) continue
      cReached = true
      sps.add(sp)
    }
    if (sps.size >= 2) {
      sps[0].vector = sps[1].vector
      val st = dState ?: initD(sps).also { dState = it }
      val finalLength = sps[sps.size - 1].runningLength
      while (dUsed + 1 < sps.size && finalLength - sps[dUsed].runningLength >= QalmFreehand.END_NOISE_THRESHOLD) {
        outlineStep(st, sps, dUsed, finalLength, left, right)
        dUsed++
      }
    }
  }

  private fun avg(a: DoubleArray, b: DoubleArray, c: DoubleArray) =
    doubleArrayOf((a[0] + 2 * b[0] + c[0]) / 4, (a[1] + 2 * b[1] + c[1]) / 4, (a[2] + 2 * b[2] + c[2]) / 4)

  /**
   * One step of getStrokePoints' loop after [prev] (with [run] so far) for input [s], [interior] = not its last input.
   * Null: the same point as [prev] (skipped). A negative distance: skipped below the minimum length, with the new
   * running length. Else the new stroke point.
   */
  private fun strokePoint(prev: StrokePoint, s: DoubleArray, run: Double, reached: Boolean, interior: Boolean): StrokePoint? {
    val point =
      if (o.last && !interior) doubleArrayOf(s[0], s[1])
      else QalmFreehand.lrp(prev.point, doubleArrayOf(s[0], s[1]), t)
    if (QalmFreehand.isEqual(prev.point, point)) return null
    val distance = QalmFreehand.dist(point, prev.point)
    val runningLength = run + distance
    if (interior && !reached && runningLength < o.size) return StrokePoint(point, 0.0, point, -1.0, runningLength)
    return StrokePoint(point, QalmFreehand.validPressure(s) ?: QalmFreehand.DEFAULT_PRESSURE, QalmFreehand.uni(QalmFreehand.sub(prev.point, point)), distance, runningLength)
  }

  private fun initD(pts: List<StrokePoint>): DState {
    val p0 = pts[0].point
    return DState(pts[0].vector, p0, p0, p0, p0, false, 0.0)
  }

  /** One step of getStrokeOutlinePoints' loop (no simulated pressure, no tapers), as in the reference. */
  private fun outlineStep(st: DState, pts: List<StrokePoint>, i: Int, totalLength: Double, l: MutableList<DoubleArray>, r: MutableList<DoubleArray>) {
    val sp = pts[i]
    val point = sp.point
    val vector = sp.vector
    val isLastPoint = i == pts.size - 1
    if (!isLastPoint && totalLength - sp.runningLength < QalmFreehand.END_NOISE_THRESHOLD) return
    var radius = if (o.thinning != 0.0) QalmFreehand.strokeRadius(o.size, o.thinning, sp.pressure) else o.size / 2
    radius = max(QalmFreehand.MIN_RADIUS, radius * 1.0)
    st.radius = radius

    val nextVector = (if (!isLastPoint) pts[i + 1] else sp).vector
    val nextDpr = if (!isLastPoint) QalmFreehand.dpr(vector, nextVector) else 1.0
    val prevDpr = QalmFreehand.dpr(vector, st.prevVector)
    val isPointSharpCorner = prevDpr < 0 && !st.prevSharp
    val isNextPointSharpCorner = nextDpr < 0

    if (isPointSharpCorner || isNextPointSharpCorner) {
      val offset = QalmFreehand.mul(QalmFreehand.per(st.prevVector), radius)
      val step = 1.0 / QalmFreehand.CORNER_CAP_SEGMENTS
      var tt = 0.0
      while (tt <= 1) {
        st.tempLeft = QalmFreehand.rotAround(QalmFreehand.sub(point, offset), point, QalmFreehand.FIXED_PI * tt)
        l.add(st.tempLeft)
        st.tempRight = QalmFreehand.rotAround(QalmFreehand.add(point, offset), point, QalmFreehand.FIXED_PI * -tt)
        r.add(st.tempRight)
        tt += step
      }
      st.prevLeft = st.tempLeft
      st.prevRight = st.tempRight
      if (isNextPointSharpCorner) st.prevSharp = true
      return
    }
    st.prevSharp = false

    if (isLastPoint) {
      val offset = QalmFreehand.mul(QalmFreehand.per(vector), radius)
      l.add(QalmFreehand.sub(point, offset))
      r.add(QalmFreehand.add(point, offset))
      return
    }

    val offset = QalmFreehand.mul(QalmFreehand.per(QalmFreehand.lrp(nextVector, vector, nextDpr)), radius)
    st.tempLeft = QalmFreehand.sub(point, offset)
    if (i <= 1 || QalmFreehand.dist2(st.prevLeft, st.tempLeft) > minDistance) {
      l.add(st.tempLeft)
      st.prevLeft = st.tempLeft
    }
    st.tempRight = QalmFreehand.add(point, offset)
    if (i <= 1 || QalmFreehand.dist2(st.prevRight, st.tempRight) > minDistance) {
      r.add(st.tempRight)
      st.prevRight = st.tempRight
    }
    st.prevVector = vector
  }
}
