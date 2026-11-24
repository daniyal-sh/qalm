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
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.SurfaceView
import android.view.View
import androidx.annotation.RequiresApi
import androidx.graphics.lowlatency.CanvasFrontBufferedRenderer
import androidx.input.motionprediction.MotionEventPredictor
import com.facebook.react.views.scroll.ReactHorizontalScrollView
import com.facebook.react.views.scroll.ReactScrollView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.util.UUID
import kotlin.math.PI
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
    val kind: String, // ink | erase | lasso
    val isPen: Boolean,
    val tool: String, // pen | highlighter
    val color: String,
    val colorInt: Int,
    val width: Double,
    val style: String,
    val smoothing: Int,
    val downTime: Long,
  ) {
    val points = ArrayList<InkPoint>()
    var predicted: List<InkPoint> = emptyList()
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
  }

  /** A finished stroke (filled outline) or snapped shape (stroked at [lineWidth] page units) until PageCanvas has it. */
  class Pending(val id: String, val path: Path, val color: Int, val alpha: Int, val lineWidth: Float = 0f)

  private var live: Live? = null
  private val pending = ArrayList<Pending>()
  private var hover: FloatArray? = null // view px

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
    return InkPoint(
      x = x / unitPxX(),
      y = y / unitPxY(),
      p = if (stylus) min(1.0, max(0.0, pressure.toDouble())) else 0.5,
      tilt = if (stylus) PI / 2 - tiltFromVertical else PI / 2,
      az = if (stylus) orientation.toDouble() else 0.0,
      t = max(0L, time - live.downTime).toDouble(),
    )
  }

  private fun addPoint(live: Live, pt: InkPoint) {
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
    if (shapeSnap && l.kind == "ink" && l.tool == "pen" && l.snapKind == null) postDelayed(holdTimeout, LiveShape.HOLD_MS)
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
    val t = if (eraser) "eraser" else tool
    if (t == "none") return false
    val kind = when (t) {
      "eraser" -> "erase"
      "lasso" -> "lasso"
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
    )
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
        if (pIdx >= 0) {
          l.predicted = (0 until predicted.historySize).map { point(predicted, pIdx, it, l) } + point(predicted, pIdx, -1, l)
        }
        predicted.recycle()
      }
    }
    if (l.kind == "erase") emitErase(l, final = false)
    render(l)
  }

  private fun finish(ev: MotionEvent, idx: Int) {
    val l = live ?: return
    addPoint(l, point(ev, idx, -1, l))
    live = null
    removeCallbacks(holdTimeout)
    when (l.kind) {
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
          Pending(id, QalmFreehand.toPath(QalmFreehand.outline(l.tool, l.width, l.points, l.style, l.smoothing)), l.colorInt, alphaFor(l))
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
          ) + (if (shapeKind != null) mapOf("shape" to mapOf("kind" to shapeKind, "pts" to l.snapCur.map { listOf(it[0], it[1]) })) else emptyMap()),
        )
      }
    }
  }

  private fun retract() {
    removeCallbacks(holdTimeout)
    live = null
    layer.drawFrame(null)
  }

  private fun emitErase(l: Live, final: Boolean) {
    val from = max(0, l.erasedUpTo - 1)
    if (l.points.size - from < (if (final) 1 else 2)) return
    val path = l.points.subList(from, l.points.size).map { mapOf("x" to it.x, "y" to it.y) }
    l.erasedUpTo = l.points.size
    onErase(mapOf("path" to path))
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
  )

  /** Pens are opaque; a highlighter uses its colour's own alpha (#rrggbbaa) or HIGHLIGHTER_ALPHA (tech-spec §2). */
  private fun alphaFor(l: Live): Int = when {
    l.tool != "highlighter" -> 255
    hasAlpha(l.color) -> Color.alpha(l.colorInt)
    else -> Math.round(HIGHLIGHTER_ALPHA * 255).toInt()
  }

  private fun render(l: Live) {
    val snapKind = l.snapKind
    val frame = when {
      l.kind == "ink" && snapKind != null -> Frame(
        shape = shapePath(snapKind, l.snapCur),
        shapeWidth = l.width.toFloat(),
        fillColor = l.colorInt,
        fillAlpha = alphaFor(l),
      )
      l.kind == "ink" -> Frame(
        fill = QalmFreehand.toPath(QalmFreehand.outline(l.tool, l.width, l.points + l.predicted, l.style, l.smoothing)),
        fillColor = l.colorInt,
        fillAlpha = alphaFor(l),
      )
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
    if (tool == "lasso" || tool == "none") return null
    return Frame(
      cursor = doubleArrayOf(h[0] / unitPxX(), h[1] / unitPxY(), strokeWidth / 2),
      cursorColor = if (tool == "eraser") ERASER_CURSOR else parseColor(colorString),
    )
  }

  private val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
  private val linePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
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
    frame.cursor?.let {
      linePaint.color = frame.cursorColor
      linePaint.alpha = 180
      linePaint.strokeWidth = resources.displayMetrics.density * px
      canvas.drawCircle(it[0].toFloat(), it[1].toFloat(), max(it[2].toFloat(), px), linePaint)
    }
    canvas.restore()
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

    override fun onDrawFrontBufferedLayer(canvas: Canvas, bufferWidth: Int, bufferHeight: Int, param: Frame) {
      canvas.drawColor(Color.TRANSPARENT, PorterDuff.Mode.CLEAR)
      paintFrame(canvas, param, unitPxX().toFloat(), unitPxY().toFloat())
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
