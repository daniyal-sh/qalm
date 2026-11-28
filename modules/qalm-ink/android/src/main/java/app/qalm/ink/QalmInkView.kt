package app.qalm.ink

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.PorterDuff
import android.os.Build
import android.os.SystemClock
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.SurfaceView
import android.view.View
import androidx.annotation.RequiresApi
import androidx.graphics.lowlatency.CanvasFrontBufferedRenderer
import androidx.input.motionprediction.MotionEventPredictor
import com.facebook.react.uimanager.RootViewUtil
import com.facebook.react.views.scroll.ReactHorizontalScrollView
import com.facebook.react.views.scroll.ReactScrollView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.util.UUID
import kotlin.math.PI
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

/**
 * Transparent live-ink overlay (tech-spec §3). It takes all input over the page and draws only the stroke in
 * progress, front-buffered, plus finished strokes until their id is in `committedIds`. Finished content is
 * drawn by PageCanvas (Skia).
 */
@SuppressLint("ViewConstructor")
class QalmInkView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val input = InkInput(object : InkInput.Host {
    override val mmPerPx get() = this@QalmInkView.mmPerPx
    override fun start(ev: MotionEvent, idx: Int, isPen: Boolean, eraser: Boolean) = this@QalmInkView.start(ev, idx, isPen, eraser)
    override fun move(ev: MotionEvent, idx: Int) = onMove(ev, idx)
    override fun finish(ev: MotionEvent, idx: Int) = this@QalmInkView.finish(ev, idx)
    override fun retract() = this@QalmInkView.retract()
    override fun rejected(reason: String) = reject(reason)
    override fun penButton() = onPenButton(mapOf("kind" to "button"))
    override fun claim(disallow: Boolean) {
      parent?.requestDisallowInterceptTouchEvent(disallow)
    }
    override fun holdScroll(hold: Boolean) = this@QalmInkView.holdScroll(hold)
    override fun penSeen() = onPenSeen(mapOf<String, Any>())
  })

  /** Scroll views this view stopped for a finger stroke (see InkInput), to be restored when it ends. */
  private val heldScrollViews = ArrayList<View>()

  private fun holdScroll(hold: Boolean) {
    if (!hold) {
      for (v in heldScrollViews) {
        when (v) {
          is ReactScrollView -> v.scrollEnabled = true
          is ReactHorizontalScrollView -> v.scrollEnabled = true
        }
      }
      heldScrollViews.clear()
      return
    }
    var p = parent
    while (p != null) {
      when {
        p is ReactScrollView && p.scrollEnabled -> { p.scrollEnabled = false; heldScrollViews.add(p) }
        p is ReactHorizontalScrollView && p.scrollEnabled -> { p.scrollEnabled = false; heldScrollViews.add(p) }
      }
      p = p.parent
    }
  }

  // ---- props ----
  var pageW = 595.0
  var pageH = 842.0
  var tool = "pen"
  var colorString = "#27272a"
  var strokeWidth = 1.8
  var penStyle = "fountain"
  var smoothing = 0
  var lassoMode = "free" // free | rect
  /** partial: the live eraser leaves a faint trail of its last ERASE_TRAIL_MS (the app splits strokes as it goes). */
  var eraserMode = "stroke"
  /** Live shapes on (the app passed `recognizeShape`): report holds with onShapeHold. */
  var shapeSnap = false
  /** The on-screen ruler (window dp), or null: pen strokes starting near its edge follow it (RulerSnap). */
  var ruler: RulerSnap.Pose? = null
  /** laser: "trail" (fades over Laser.FADE_MS) or "dot" (one point under the pen). */
  var laserMode = "trail"
  var drawWith by input::drawWith
  var hand by input::hand
  var palm by input::palm

  fun setCommittedIds(ids: List<String>) {
    val committed = ids.toHashSet()
    val done = synchronized(pending) { pending.filter { it.id in committed }.map { it.id } }
    // committedIds arrive once Skia has its new picture; it shows it a frame or two later, so keep ours until then.
    for (id in done) postDelayed({ dropPending(id) }, HANDOFF_MS)
  }

  private fun dropPending(id: String) {
    val changed = synchronized(pending) { pending.removeAll { it.id == id } }
    if (changed) layer.redrawPending()
  }

  fun propsChanged() {
    if (tool != "laser") laser.clear()
    if (hover != null && live == null) layer.drawFrame(frameForHover())
  }

  // ---- events ----
  private val onStrokeEnd by EventDispatcher()
  private val onErase by EventDispatcher()
  private val onLasso by EventDispatcher()
  private val onPenButton by EventDispatcher()
  private val onRejectedTouch by EventDispatcher()
  private val onShapeHold by EventDispatcher()
  private val onPenSeen by EventDispatcher()

  // ---- state ----
  private class Live(
    val pointerId: Int,
    val kind: String, // ink | erase | lasso | laser
    val isPen: Boolean,
    val tool: String, // pen | highlighter
    val color: String,
    val colorInt: Int,
    val width: Double,
    val style: String,
    val smoothing: Int,
    val downTime: Long,
    /** Tells strokes apart on the render thread (partial redraws compare frames of one stroke). */
    val seq: Long,
  ) {
    val points = ArrayList<InkPoint>()
    var predicted: List<InkPoint> = emptyList()
    /** The outline, recomputed per sample from the tail only (LiveOutline: exactly QalmFreehand.outline). */
    val outliner by lazy { LiveOutline(tool, width, style, smoothing) }
    var holdX = 0.0
    var holdY = 0.0
    var holdT = 0.0
    /** Index of the point where the hold began. */
    var holdIdx = 0
    /** The onShapeHold this stroke is waiting on (-1: none). */
    var holdRequest = -1
    /** Snapped while held: the shape under the pen ([base] as recognised, [cur] adjusted), and where the pen was. */
    var snapKind: String? = null
    var snapBase: List<DoubleArray> = emptyList()
    var snapCur: List<DoubleArray> = emptyList()
    var snapFrom = doubleArrayOf(0.0, 0.0)
    var erasedUpTo = 0
    /** Along the ruler: the line (page units: ax, ay, bx, by) every point is projected onto. */
    var line: DoubleArray? = null
  }

  /** A finished stroke (filled outline) or snapped shape (stroked at [lineWidth] page units) until PageCanvas has it. */
  class Pending(val id: String, val path: Path, val color: Int, val alpha: Int, val lineWidth: Float = 0f)

  private var live: Live? = null
  private var strokeSeq = 0L
  private val pending = ArrayList<Pending>()
  private var hover: FloatArray? = null // view px
  /** The laser's trail (page units, uptime ms), fading after the pen lifts too. Never saved. */
  private val laser = ArrayList<Laser.Pt>()
  private val laserTick = Runnable { tickLaser() }

  private val mmPerPx: Double
    get() = resources.displayMetrics.let { InkInput.mmPerPx(it.xdpi, it.densityDpi) }

  private val predictor = MotionEventPredictor.newInstance(this)
  private val layer: InkLayer =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) FrontBufferedLayer() else ViewLayer()

  init {
    setWillNotDraw(true)
    addView(layer.view)
  }

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    val w = r - l
    val h = b - t
    layer.view.measure(MeasureSpec.makeMeasureSpec(w, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(h, MeasureSpec.EXACTLY))
    layer.view.layout(0, 0, w, h)
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    layer.attach()
  }

  override fun onDetachedFromWindow() {
    removeCallbacks(laserTick)
    laser.clear()
    input.reset()
    layer.release()
    super.onDetachedFromWindow()
  }

  // ---- geometry ----
  private fun unitPxX() = width / pageW
  private fun unitPxY() = height / pageH

  private fun point(ev: MotionEvent, idx: Int, h: Int, live: Live): InkPoint {
    val x = if (h < 0) ev.getX(idx) else ev.getHistoricalX(idx, h)
    val y = if (h < 0) ev.getY(idx) else ev.getHistoricalY(idx, h)
    val time = if (h < 0) ev.eventTime else ev.getHistoricalEventTime(h)
    val stylus = InkInput.isPenTool(ev.getToolType(idx))
    val pressure = if (h < 0) ev.getPressure(idx) else ev.getHistoricalPressure(idx, h)
    val tiltFromVertical = if (h < 0) ev.getAxisValue(MotionEvent.AXIS_TILT, idx) else ev.getHistoricalAxisValue(MotionEvent.AXIS_TILT, idx, h)
    val orientation = if (h < 0) ev.getOrientation(idx) else ev.getHistoricalOrientation(idx, h)
    var px = x / unitPxX()
    var py = y / unitPxY()
    live.line?.let { l ->
      val q = RulerSnap.project(px, py, l[0], l[1], l[2], l[3])
      px = q[0]
      py = q[1]
    }
    return InkPoint(
      x = px,
      y = py,
      p = if (stylus) min(1.0, max(0.0, pressure.toDouble())) else 0.5,
      tilt = if (stylus) PI / 2 - tiltFromVertical else PI / 2,
      az = if (stylus) orientation.toDouble() else 0.0,
      t = max(0L, time - live.downTime).toDouble(),
    )
  }

  private fun addPoint(live: Live, pt: InkPoint) {
    if (live.kind == "laser") {
      laser.add(Laser.Pt(pt.x.toFloat(), pt.y.toFloat(), live.downTime + pt.t.toLong(), live.points.isEmpty()))
      live.points.add(pt)
      return
    }
    val kind = live.snapKind
    if (kind != null) {
      // Adjusting: the stroke stays as drawn; the shape follows the pen.
      live.snapCur = LiveShape.adjust(kind, live.snapBase, live.snapFrom, doubleArrayOf(pt.x, pt.y))
      return
    }
    val prev = live.points.lastOrNull()
    if (prev != null && prev.x == pt.x && prev.y == pt.y) return
    live.points.add(pt)
    // Holding still: within HOLD_MM of where the hold began (not of the previous point, so a slow drift ends it).
    val mmPerUnit = unitPxX() * mmPerPx
    if (live.points.size == 1 || hypot(pt.x - live.holdX, pt.y - live.holdY) * mmPerUnit > LiveShape.HOLD_MM) {
      live.holdX = pt.x
      live.holdY = pt.y
      live.holdT = pt.t
      live.holdIdx = live.points.size - 1
      live.holdRequest = -1 // an answer to an earlier hold is stale now
      armHold(live)
    }
  }

  // ---- live shapes: the hold is timed here, recognition runs in JS (onShapeHold → setShapePreview) ----
  private var holdCounter = 0
  private val holdTimeout = Runnable { holdElapsed() }

  private fun armHold(l: Live) {
    removeCallbacks(holdTimeout)
    // A stroke along the ruler is a straight line already: it never snaps to a shape.
    if (shapeSnap && l.kind == "ink" && l.tool == "pen" && l.snapKind == null && l.line == null) postDelayed(holdTimeout, LiveShape.HOLD_MS)
  }

  private fun holdElapsed() {
    val l = live ?: return
    if (l.snapKind != null || l.kind != "ink" || l.points.size < 2) return
    l.holdRequest = ++holdCounter
    onShapeHold(
      mapOf(
        "requestId" to l.holdRequest,
        "points" to l.points.subList(0, l.holdIdx + 1).map { mapOf("x" to it.x, "y" to it.y) },
      ),
    )
  }

  /** JS answered a hold: snap if the pen is still down and still holding there (else the answer is stale). */
  fun shapePreview(requestId: Int, kind: String?, pts: List<DoubleArray>) {
    val l = live ?: return
    if (kind == null || l.holdRequest != requestId || l.snapKind != null) return
    val last = l.points.last()
    l.snapKind = kind
    l.snapBase = pts
    l.snapCur = pts
    l.snapFrom = doubleArrayOf(last.x, last.y)
    l.predicted = emptyList()
    performHapticFeedback(
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.CLOCK_TICK,
    )
    render(l)
  }

  private fun shapePath(kind: String, pts: List<DoubleArray>): Path = Path().apply {
    for (pl in LiveShape.polylines(kind, pts)) {
      pl.forEachIndexed { i, p -> if (i == 0) moveTo(p[0].toFloat(), p[1].toFloat()) else lineTo(p[0].toFloat(), p[1].toFloat()) }
    }
  }

  // ---- input (palm rejection and the touch state machine live in InkInput) ----
  @SuppressLint("ClickableViewAccessibility")
  override fun onTouchEvent(ev: MotionEvent): Boolean {
    if (tool == "none") return false
    predictor.record(ev)
    input.onTouchEvent(ev)
    // Keep receiving the gesture (a pen may land after a rejected palm). A parent ScrollView can still intercept
    // finger drags until a stroke starts or a palm is rejected; ViewGroup clears that flag when the gesture ends.
    return true
  }

  private fun reject(reason: String) = onRejectedTouch(mapOf("reason" to reason))

  private fun start(ev: MotionEvent, idx: Int, isPen: Boolean, eraser: Boolean): Boolean {
    val t = Laser.toolFor(tool, eraser)
    if (t == "none") return false
    val kind = when (t) {
      "eraser" -> "erase"
      "lasso" -> "lasso"
      "laser" -> "laser"
      else -> "ink"
    }
    val l = Live(
      pointerId = ev.getPointerId(idx),
      kind = kind,
      isPen = isPen,
      tool = if (t == "highlighter") "highlighter" else "pen",
      color = colorString,
      colorInt = parseColor(colorString),
      width = strokeWidth,
      style = penStyle,
      smoothing = smoothing,
      downTime = ev.eventTime,
      seq = ++strokeSeq,
    )
    if (kind == "ink") l.line = rulerLine(ev.getX(idx), ev.getY(idx), l.width / 2)
    live = l
    hover = null
    addPoint(l, point(ev, idx, -1, l))
    requestUnbufferedDispatch(ev) // deliver every sample as it arrives, not batched per frame
    render(l)
    return true
  }

  private fun onMove(ev: MotionEvent, idx: Int) {
    val l = live ?: return
    for (h in 0 until ev.historySize) addPoint(l, point(ev, idx, h, l))
    addPoint(l, point(ev, idx, -1, l))
    l.predicted = emptyList()
    if (l.kind == "ink" && l.snapKind == null) {
      val predicted = predictor.predict()
      if (predicted != null) {
        val pIdx = predicted.findPointerIndex(l.pointerId)
        val last = l.points.lastOrNull()
        if (pIdx >= 0 && last != null) {
          // Only the position is guessed: at the last real pressure and tilt, a guess taken back on the next move
          // doesn't also make the tip swell and shrink.
          l.predicted = ((0 until predicted.historySize).map { point(predicted, pIdx, it, l) } + point(predicted, pIdx, -1, l))
            .map { it.copy(p = last.p, tilt = last.tilt, az = last.az) }
        }
        predicted.recycle()
      }
    }
    if (l.kind == "erase") emitErase(l, final = false)
    render(l)
  }

  // ---- ruler: the window-dp pose, mapped onto this page ----
  /**
   * This view's origin in React Native's window coordinates (px), exactly as `measureInWindow` reports them: RN's own
   * `RootViewUtil.getViewportOffset` (its place in the window; less the status bar and cutout only when the app isn't
   * edge-to-edge, which Expo 58 is). Needs a check on a device with a status bar.
   */
  private fun rnWindowOrigin(): IntArray {
    val o = RootViewUtil.getViewportOffset(this)
    return intArrayOf(o.x, o.y)
  }

  /**
   * The ruler line a stroke starting at view px (x, y) follows (page units, pushed out by [offset]), or null. The
   * pose is in React Native window dp (measureInWindow), so this view's origin is measured the same way.
   */
  private fun rulerLine(x: Float, y: Float, offset: Double): DoubleArray? {
    val r = ruler ?: return null
    val d = resources.displayMetrics.density.toDouble()
    val o = rnWindowOrigin()
    val edge = RulerSnap.edgeAt(r, (o[0] + x) / d, (o[1] + y) / d) ?: return null
    val toPage = { wx: Double, wy: Double -> doubleArrayOf((wx * d - o[0]) / unitPxX(), (wy * d - o[1]) / unitPxY()) }
    return RulerSnap.line(edge, toPage, offset)
  }

  // ---- laser: a fading trail (or a dot) on the front buffer; nothing is emitted or saved ----
  private fun tickLaser() {
    removeCallbacks(laserTick)
    Laser.prune(laser, SystemClock.uptimeMillis())
    val l = live
    val at = if (l?.kind == "laser") l.points.lastOrNull()?.let { floatArrayOf(it.x.toFloat(), it.y.toFloat()) } else null
    layer.drawFrame(laserFrame(at))
    if (laser.isNotEmpty() || l?.kind == "laser") postOnAnimation(laserTick)
  }

  private fun laserFrame(at: FloatArray?): Frame = Frame(
    laser = if (laserMode == "dot") emptyList() else laser.toList(),
    laserNow = SystemClock.uptimeMillis(),
    laserDot = if (laserMode == "dot") at else null,
  )

  private fun finish(ev: MotionEvent, idx: Int) {
    val l = live ?: return
    addPoint(l, point(ev, idx, -1, l))
    live = null
    removeCallbacks(holdTimeout)
    when (l.kind) {
      "laser" -> tickLaser() // nothing to save: the trail fades on its own
      "erase" -> {
        emitErase(l, final = true)
        layer.drawFrame(null)
      }
      "lasso" -> {
        if (l.points.isNotEmpty()) onLasso(mapOf("polygon" to l.points.map { mapOf("x" to it.x, "y" to it.y) }))
        layer.drawFrame(null)
      }
      else -> {
        val id = UUID.randomUUID().toString()
        val last = l.points.last()
        val heldMs = max(0.0, max(last.t, (ev.eventTime - l.downTime).toDouble()) - l.holdT)
        val shapeKind = l.snapKind
        val pend = if (shapeKind != null) {
          Pending(id, shapePath(shapeKind, l.snapCur), l.colorInt, alphaFor(l), l.width.toFloat())
        } else {
          Pending(id, QalmFreehand.toPath(l.outliner.outline(l.points, emptyList())), l.colorInt, alphaFor(l))
        }
        synchronized(pending) { pending.add(pend) }
        layer.commit()
        // Never committed (e.g. the app snapped it to a shape): drop it anyway, as iOS does.
        postDelayed({ dropPending(id) }, PENDING_FALLBACK_MS)
        onStrokeEnd(
          mapOf(
            "id" to id,
            "tool" to l.tool,
            "color" to l.color,
            "width" to l.width,
            "points" to l.points.map {
              mapOf("x" to it.x, "y" to it.y, "p" to it.p, "tilt" to it.tilt, "az" to it.az, "t" to it.t)
            },
            "heldMs" to Math.round(heldMs).toDouble(),
            "style" to l.style,
            "smoothing" to l.smoothing,
            "ruler" to (l.line != null),
          ) + (if (shapeKind != null) mapOf("shape" to mapOf("kind" to shapeKind, "pts" to l.snapCur.map { listOf(it[0], it[1]) })) else emptyMap()),
        )
      }
    }
  }

  private fun retract() {
    removeCallbacks(holdTimeout)
    val wasLaser = live?.kind == "laser"
    live = null
    if (wasLaser) tickLaser() else layer.drawFrame(null)
  }

  private fun emitErase(l: Live, final: Boolean) {
    val from = max(0, l.erasedUpTo - 1)
    if (l.points.size - from < (if (final) 1 else 2)) return
    val path = l.points.subList(from, l.points.size).map { mapOf("x" to it.x, "y" to it.y) }
    l.erasedUpTo = l.points.size
    onErase(if (final) mapOf("path" to path, "final" to true) else mapOf("path" to path))
  }

  // ---- hover (brush preview) ----
  override fun onHoverEvent(ev: MotionEvent): Boolean {
    if (tool == "none" || !InkInput.isPenTool(ev.getToolType(0))) return super.onHoverEvent(ev)
    input.onHoverEvent(ev)
    when (ev.actionMasked) {
      MotionEvent.ACTION_HOVER_ENTER, MotionEvent.ACTION_HOVER_MOVE -> {
        hover = floatArrayOf(ev.x, ev.y)
        if (live == null) layer.drawFrame(frameForHover())
      }
      MotionEvent.ACTION_HOVER_EXIT -> {
        hover = null
        if (live == null) layer.drawFrame(null)
      }
    }
    return true
  }

  // ---- drawing ----
  /** An immutable snapshot of what the front layer shows, in page units. */
  class Frame(
    val fill: Path? = null,
    val fillColor: Int = 0,
    val fillAlpha: Int = 255,
    val lasso: Path? = null,
    val cursor: DoubleArray? = null, // x, y, radius
    val cursorColor: Int = 0,
    /** A snapped shape: stroked at [shapeWidth] page units in [fillColor] / [fillAlpha]. */
    val shape: Path? = null,
    val shapeWidth: Float = 0f,
    /** Partial erase: where the eraser just went, stroked at [trailWidth] page units. */
    val trail: Path? = null,
    val trailWidth: Float = 0f,
    /** Laser: the trail (each segment faded by its age at [laserNow]) and the dot, page units. */
    val laser: List<Laser.Pt> = emptyList(),
    val laserNow: Long = 0L,
    val laserDot: FloatArray? = null,
    /** The live stroke's outline (page units) that [fill] traces, and which stroke it is: for partial redraws. */
    val outline: List<DoubleArray>? = null,
    val seq: Long = -1,
  )

  /** Pens are opaque; a highlighter uses its colour's own alpha (#rrggbbaa) or HIGHLIGHTER_ALPHA (tech-spec §2). */
  private fun alphaFor(l: Live): Int = when {
    l.tool != "highlighter" -> 255
    hasAlpha(l.color) -> Color.alpha(l.colorInt)
    else -> Math.round(HIGHLIGHTER_ALPHA * 255).toInt()
  }

  private fun render(l: Live) {
    if (l.kind == "laser") return tickLaser()
    val snapKind = l.snapKind
    val frame = when {
      l.kind == "ink" && snapKind != null -> Frame(
        shape = shapePath(snapKind, l.snapCur),
        shapeWidth = l.width.toFloat(),
        fillColor = l.colorInt,
        fillAlpha = alphaFor(l),
      )
      l.kind == "ink" -> l.outliner.outline(l.points, l.predicted).let {
        Frame(fill = QalmFreehand.toPath(it), fillColor = l.colorInt, fillAlpha = alphaFor(l), outline = it, seq = l.seq)
      }
      l.kind == "lasso" -> Frame(
        lasso = Path().apply {
          val a = l.points.firstOrNull()
          val b = l.points.lastOrNull()
          if (lassoMode == "rect" && a != null && b != null) {
            addRect(
              min(a.x, b.x).toFloat(), min(a.y, b.y).toFloat(), max(a.x, b.x).toFloat(), max(a.y, b.y).toFloat(),
              Path.Direction.CW,
            )
          } else {
            l.points.forEachIndexed { i, p -> if (i == 0) moveTo(p.x.toFloat(), p.y.toFloat()) else lineTo(p.x.toFloat(), p.y.toFloat()) }
            close()
          }
        },
      )
      else -> l.points.lastOrNull()?.let {
        Frame(cursor = doubleArrayOf(it.x, it.y, l.width / 2), cursorColor = ERASER_CURSOR, trail = eraseTrail(l), trailWidth = l.width.toFloat())
      } ?: Frame()
    }
    layer.drawFrame(frame)
  }

  /** Partial erase: the eraser's path over its last ERASE_TRAIL_MS (null in whole-stroke mode). */
  private fun eraseTrail(l: Live): Path? {
    if (eraserMode != "partial" || l.points.size < 2) return null
    val now = l.points.last().t
    val trail = l.points.filter { it.t >= now - ERASE_TRAIL_MS }
    if (trail.size < 2) return null
    return Path().apply { trail.forEachIndexed { i, p -> if (i == 0) moveTo(p.x.toFloat(), p.y.toFloat()) else lineTo(p.x.toFloat(), p.y.toFloat()) } }
  }

  private fun frameForHover(): Frame? {
    val h = hover ?: return null
    if (tool == "laser") return if (laserMode == "dot") laserFrame(floatArrayOf((h[0] / unitPxX()).toFloat(), (h[1] / unitPxY()).toFloat())) else null
    if (tool == "lasso" || tool == "none") return null
    return Frame(
      cursor = doubleArrayOf(h[0] / unitPxX(), h[1] / unitPxY(), strokeWidth / 2),
      cursorColor = if (tool == "eraser") ERASER_CURSOR else parseColor(colorString),
    )
  }

  private val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
  private val linePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
  /** Clears what a laser run covers in its layer (DST_OUT), before the run is drawn. */
  private val clearPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE
    strokeCap = Paint.Cap.ROUND
    strokeJoin = Paint.Join.ROUND
    xfermode = android.graphics.PorterDuffXfermode(PorterDuff.Mode.DST_OUT)
  }
  /** Shapes: round caps and joins, as PageCanvas draws them. */
  private val shapePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE
    strokeCap = Paint.Cap.ROUND
    strokeJoin = Paint.Join.ROUND
  }

  /** Runs on the render thread (front-buffered) or the UI thread (fallback). */
  private fun paintPending(canvas: Canvas, sx: Float, sy: Float) {
    val snapshot = synchronized(pending) { pending.toList() }
    canvas.save()
    canvas.scale(sx, sy)
    for (p in snapshot) {
      if (p.lineWidth > 0f) {
        shapePaint.color = p.color
        shapePaint.alpha = p.alpha
        shapePaint.strokeWidth = p.lineWidth
        canvas.drawPath(p.path, shapePaint)
        continue
      }
      fillPaint.color = p.color
      fillPaint.alpha = p.alpha
      canvas.drawPath(p.path, fillPaint)
    }
    canvas.restore()
  }

  private fun paintFrame(canvas: Canvas, frame: Frame, sx: Float, sy: Float) {
    canvas.save()
    canvas.scale(sx, sy)
    frame.fill?.let {
      fillPaint.color = frame.fillColor
      fillPaint.alpha = frame.fillAlpha
      canvas.drawPath(it, fillPaint)
    }
    frame.shape?.let {
      shapePaint.color = frame.fillColor
      shapePaint.alpha = frame.fillAlpha
      shapePaint.strokeWidth = frame.shapeWidth
      canvas.drawPath(it, shapePaint)
    }
    val px = 1f / sx // one view px in page units
    frame.lasso?.let {
      linePaint.color = LASSO_COLOR
      linePaint.alpha = 255
      linePaint.strokeWidth = 1.5f * resources.displayMetrics.density * px
      linePaint.pathEffect = DashPathEffect(floatArrayOf(6f * resources.displayMetrics.density * px, 4f * resources.displayMetrics.density * px), 0f)
      canvas.drawPath(it, linePaint)
      linePaint.pathEffect = null
    }
    frame.trail?.let {
      shapePaint.color = ERASER_CURSOR
      shapePaint.alpha = 41 // ~0.16
      shapePaint.strokeWidth = frame.trailWidth
      canvas.drawPath(it, shapePaint)
    }
    if (frame.laser.size > 1 || frame.laserDot != null) paintLaser(canvas, frame, px * resources.displayMetrics.density)
    frame.cursor?.let {
      linePaint.color = frame.cursorColor
      linePaint.alpha = 180
      linePaint.strokeWidth = resources.displayMetrics.density * px
      canvas.drawCircle(it[0].toFloat(), it[1].toFloat(), max(it[2].toFloat(), px), linePaint)
    }
    canvas.restore()
  }

  /** The laser: a soft glow (the dark theme's `bad` tint) under a solid `bad` core, each segment faded by age. [dp] in page units. */
  private fun paintLaser(canvas: Canvas, frame: Frame, dp: Float) {
    // Each layer on its own: a run of the trail in one fade band is one path (no joints painted twice), and each run
    // first clears what it covers, so where two bands meet the newer one shows, not both (no beads at the joints).
    val runs = Laser.runs(frame.laser, frame.laserNow).map { (pts, alpha) ->
      Path().apply { pts.forEachIndexed { i, p -> if (i == 0) moveTo(p.x, p.y) else lineTo(p.x, p.y) } } to alpha
    }
    if (runs.isNotEmpty()) {
      for (pass in 0..1) {
        val width = (if (pass == 0) 10f else 3f) * dp
        val layer = canvas.saveLayer(null, null)
        shapePaint.color = if (pass == 0) LASER_GLOW else LASER_CORE
        shapePaint.strokeWidth = width
        clearPaint.strokeWidth = width
        for ((path, alpha) in runs) {
          canvas.drawPath(path, clearPaint)
          shapePaint.alpha = Math.round(255 * alpha * (if (pass == 0) 0.35f else 1f))
          canvas.drawPath(path, shapePaint)
        }
        canvas.restoreToCount(layer)
      }
    }
    frame.laserDot?.let {
      fillPaint.color = LASER_GLOW
      fillPaint.alpha = 90
      canvas.drawCircle(it[0], it[1], 9f * dp, fillPaint)
      fillPaint.color = LASER_CORE
      fillPaint.alpha = 255
      canvas.drawCircle(it[0], it[1], 4f * dp, fillPaint)
    }
  }

  private interface InkLayer {
    val view: View
    fun attach()
    fun release()
    /** Show [frame] (null = nothing) on the low-latency layer. */
    fun drawFrame(frame: Frame?)
    /** Move the live stroke to the pending layer (pending already contains it). */
    fun commit()
    fun redrawPending()
  }

  /** API 29+: CanvasFrontBufferedRenderer over a translucent, on-top SurfaceView. */
  @RequiresApi(Build.VERSION_CODES.Q)
  private inner class FrontBufferedLayer : InkLayer, CanvasFrontBufferedRenderer.Callback<Frame> {
    override val view = SurfaceView(context).apply {
      setZOrderOnTop(true)
      holder.setFormat(PixelFormat.TRANSLUCENT)
    }
    private var renderer: CanvasFrontBufferedRenderer<Frame>? = null
    private val empty = Frame()

    // What the front buffer shows now. Render thread only. The buffer keeps its contents between draws.
    private var shown: Frame? = null
    private var shownW = 0
    private var shownH = 0
    private var shownSx = 0f
    private var shownSy = 0f

    override fun attach() {
      if (renderer == null) renderer = CanvasFrontBufferedRenderer(view, this)
    }

    override fun release() {
      renderer?.release(true)
      renderer = null
    }

    override fun drawFrame(frame: Frame?) {
      renderer?.renderFrontBufferedLayer(frame ?: empty)
    }

    override fun commit() {
      renderer?.commit()
    }

    override fun redrawPending() {
      renderer?.renderMultiBufferedLayer(emptyList())
    }

    /**
     * The display reads this buffer while it is drawn, so a move of the live stroke clears and redraws only the box
     * where its outline changed (InkDamage). Clearing it all on every sample tore and flickered at the tip.
     */
    override fun onDrawFrontBufferedLayer(canvas: Canvas, bufferWidth: Int, bufferHeight: Int, param: Frame) {
      val sx = unitPxX().toFloat()
      val sy = unitPxY().toFloat()
      val was = shown
      val prev = was?.outline
      val cur = param.outline
      shown = param
      val sameStroke = was != null && prev != null && cur != null && was.seq == param.seq &&
        bufferWidth == shownW && bufferHeight == shownH && sx == shownSx && sy == shownSy
      shownW = bufferWidth
      shownH = bufferHeight
      shownSx = sx
      shownSy = sy
      if (sameStroke && prev != null && cur != null) {
        val box = InkDamage.changedBounds(prev, cur) ?: return // nothing moved
        canvas.save()
        // Whole px, with room for antialiasing.
        canvas.clipRect(
          floor(box[0] * sx).toFloat() - 2f,
          floor(box[1] * sy).toFloat() - 2f,
          ceil(box[2] * sx).toFloat() + 2f,
          ceil(box[3] * sy).toFloat() + 2f,
        )
        canvas.drawColor(Color.TRANSPARENT, PorterDuff.Mode.CLEAR)
        paintFrame(canvas, param, sx, sy)
        canvas.restore()
        return
      }
      canvas.drawColor(Color.TRANSPARENT, PorterDuff.Mode.CLEAR)
      paintFrame(canvas, param, sx, sy)
    }

    override fun onDrawMultiBufferedLayer(canvas: Canvas, bufferWidth: Int, bufferHeight: Int, params: Collection<Frame>) {
      canvas.drawColor(Color.TRANSPARENT, PorterDuff.Mode.CLEAR)
      paintPending(canvas, unitPxX().toFloat(), unitPxY().toFloat())
    }
  }

  /** Below API 29: a plain transparent view (not front-buffered). */
  private inner class ViewLayer : InkLayer {
    private var frame: Frame? = null
    override val view = object : View(context) {
      override fun onDraw(canvas: Canvas) {
        paintPending(canvas, unitPxX().toFloat(), unitPxY().toFloat())
        frame?.let { paintFrame(canvas, it, unitPxX().toFloat(), unitPxY().toFloat()) }
      }
    }
    override fun attach() {}
    override fun release() {}
    override fun drawFrame(frame: Frame?) {
      this.frame = frame
      view.invalidate()
    }
    override fun commit() = drawFrame(null)
    override fun redrawPending() = view.invalidate()
  }

  companion object {
    // Palm rejection constants live in InkInput (tech-spec §3); the live-shape hold in LiveShape.
    /** A finished stroke whose id never reaches committedIds is dropped after this (same as iOS). */
    const val PENDING_FALLBACK_MS = 4000L
    /** How long a finished stroke stays after its id is in committedIds (same as iOS). */
    const val HANDOFF_MS = 50L
    /** Partial erase: the trail under the eraser (InkOverlay.types ERASE_TRAIL_MS). */
    const val ERASE_TRAIL_MS = 250.0
    const val HIGHLIGHTER_ALPHA = 0.45
    val LASSO_COLOR = Color.parseColor("#4338ca")
    val ERASER_CURSOR = Color.parseColor("#8b8b95")
    /** InkOverlay.types LASER_CORE / LASER_GLOW: brand `bad` and its dark-theme tint. */
    val LASER_CORE = Color.parseColor("#b91c1c")
    val LASER_GLOW = Color.parseColor("#f87171")

    private fun hasAlpha(s: String) = s.trim().length == 9

    /** `#rrggbb` or `#rrggbbaa` (CSS order; Android's own parser reads 8 digits as #aarrggbb). */
    fun parseColor(s: String): Int = try {
      val h = s.trim()
      if (h.length == 9 && h.startsWith("#")) {
        val v = h.substring(1).toLong(16)
        Color.argb((v and 0xff).toInt(), ((v shr 24) and 0xff).toInt(), ((v shr 16) and 0xff).toInt(), ((v shr 8) and 0xff).toInt())
      } else Color.parseColor(h)
    } catch (e: IllegalArgumentException) {
      Color.BLACK
    }
  }
}
