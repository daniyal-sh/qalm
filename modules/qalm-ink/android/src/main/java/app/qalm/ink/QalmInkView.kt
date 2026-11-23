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
import android.view.MotionEvent
import android.view.SurfaceView
import android.view.View
import androidx.annotation.RequiresApi
import androidx.graphics.lowlatency.CanvasFrontBufferedRenderer
import androidx.input.motionprediction.MotionEventPredictor
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
  // ---- props ----
  var pageW = 595.0
  var pageH = 842.0
  var tool = "pen"
  var colorString = "#27272a"
  var strokeWidth = 1.8
  var drawWith = "pen"
  var hand = "right"
  var palm = "standard"

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

  // ---- state ----
  private class Live(
    val pointerId: Int,
    val kind: String, // ink | erase | lasso
    val isPen: Boolean,
    val tool: String, // pen | highlighter
    val color: String,
    val colorInt: Int,
    val width: Double,
    val downTime: Long,
  ) {
    val points = ArrayList<InkPoint>()
    var predicted: List<InkPoint> = emptyList()
    var holdX = 0.0
    var holdY = 0.0
    var holdT = 0.0
    var erasedUpTo = 0
  }

  class Pending(val id: String, val path: Path, val color: Int, val alpha: Int)

  private var live: Live? = null
  private val pending = ArrayList<Pending>()
  private var hover: FloatArray? = null // view px
  private var lastPenTime = Long.MIN_VALUE / 2
  private var lastPenX = 0f
  private var lastPenY = 0f
  private var buttonDown = false

  private val mmPerPx: Double
    get() = 25.4 / max(1f, resources.displayMetrics.xdpi)

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
    val stylus = isPenTool(ev.getToolType(idx))
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
    val prev = live.points.lastOrNull()
    if (prev != null && prev.x == pt.x && prev.y == pt.y) return
    live.points.add(pt)
    val mmPerUnit = unitPxX() * mmPerPx
    if (live.points.size == 1 || hypot(pt.x - live.holdX, pt.y - live.holdY) * mmPerUnit > HOLD_MOVE_MM) {
      live.holdX = pt.x
      live.holdY = pt.y
      live.holdT = pt.t
    }
  }

  // ---- input ----
  private fun isPenTool(t: Int) = t == MotionEvent.TOOL_TYPE_STYLUS || t == MotionEvent.TOOL_TYPE_ERASER

  private fun penButtonPressed(ev: MotionEvent, idx: Int): Boolean =
    ev.getToolType(idx) == MotionEvent.TOOL_TYPE_ERASER ||
      (ev.buttonState and (MotionEvent.BUTTON_STYLUS_PRIMARY or MotionEvent.BUTTON_STYLUS_SECONDARY)) != 0

  private fun firePenButton(pressed: Boolean) {
    if (pressed && !buttonDown) onPenButton(mapOf("kind" to "button"))
    buttonDown = pressed
  }

  private fun notePen(ev: MotionEvent, idx: Int) {
    lastPenTime = ev.eventTime
    lastPenX = ev.getX(idx)
    lastPenY = ev.getY(idx)
  }

  private fun reject(reason: String) = onRejectedTouch(mapOf("reason" to reason))

  private fun handSide(x: Float, y: Float, time: Long): Boolean {
    if (time - lastPenTime > HAND_SIDE_WINDOW_MS) return false
    val margin = HAND_SIDE_MARGIN_MM / mmPerPx
    val dx = x - lastPenX
    val dy = y - lastPenY
    val beside = if (hand == "right") dx > -margin else dx < margin
    return beside && dy > -margin
  }

  @SuppressLint("ClickableViewAccessibility")
  override fun onTouchEvent(ev: MotionEvent): Boolean {
    if (tool == "none") return false
    predictor.record(ev)
    when (ev.actionMasked) {
      MotionEvent.ACTION_DOWN, MotionEvent.ACTION_POINTER_DOWN -> onDown(ev, ev.actionIndex)
      MotionEvent.ACTION_MOVE -> onMove(ev)
      MotionEvent.ACTION_POINTER_UP, MotionEvent.ACTION_UP -> {
        val idx = ev.actionIndex
        if (isPenTool(ev.getToolType(idx))) {
          notePen(ev, idx)
          buttonDown = false
        }
        val l = live
        if (l != null && ev.getPointerId(idx) == l.pointerId) {
          // FLAG_CANCELED: the OS decided this pointer was accidental (palm). Retract instead of committing.
          if ((ev.flags and FLAG_CANCELED) != 0) retract("cancelled") else finish(ev, idx, l)
        }
      }
      MotionEvent.ACTION_CANCEL -> if (live != null) retract("cancelled")
    }
    // Keep receiving the gesture (a pen may land after a rejected palm). A parent ScrollView can still intercept
    // finger drags until a stroke starts or a palm is rejected; ViewGroup clears that flag when the gesture ends.
    return true
  }

  private fun onDown(ev: MotionEvent, idx: Int) {
    val toolType = ev.getToolType(idx)
    val x = ev.getX(idx)
    val y = ev.getY(idx)
    when {
      isPenTool(toolType) -> {
        notePen(ev, idx)
        val button = penButtonPressed(ev, idx)
        firePenButton(button)
        if (live?.isPen == false) retract("pen-took-over") // the palm got there first
        if (live == null) start(ev, idx, isPen = true, eraser = button)
      }
      toolType == MotionEvent.TOOL_TYPE_FINGER || toolType == MotionEvent.TOOL_TYPE_UNKNOWN -> {
        if (drawWith == "pen") return reject("pen-only") // fingers scroll and zoom
        val palmReason = when {
          palmSizeExceeded(ev, idx) -> "palm-size"
          ev.eventTime - lastPenTime < PEN_LOCKOUT_MS -> "pen-lockout"
          handSide(x, y, ev.eventTime) -> "hand-side"
          else -> null
        }
        if (palmReason != null) {
          parent?.requestDisallowInterceptTouchEvent(true) // swallow the palm so it doesn't scroll the page
          return reject(palmReason)
        }
        val l = live
        when {
          l == null -> start(ev, idx, isPen = false, eraser = false)
          l.isPen -> reject("pen-active")
          else -> {
            // A second finger: this is a scroll / zoom, not ink.
            retract("multi-touch")
            parent?.requestDisallowInterceptTouchEvent(false)
          }
        }
      }
      else -> if (live == null) start(ev, idx, isPen = false, eraser = false) // mouse
    }
  }

  private fun palmSizeExceeded(ev: MotionEvent, idx: Int) = ev.getTouchMajor(idx) * mmPerPx > (PALM_MAJOR_MM[palm] ?: 7.0)

  private fun start(ev: MotionEvent, idx: Int, isPen: Boolean, eraser: Boolean) {
    val t = if (eraser) "eraser" else tool
    if (t == "none") return
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
      downTime = ev.eventTime,
    )
    live = l
    hover = null
    addPoint(l, point(ev, idx, -1, l))
    parent?.requestDisallowInterceptTouchEvent(true)
    requestUnbufferedDispatch(ev) // deliver every sample as it arrives, not batched per frame
    render(l)
  }

  private fun onMove(ev: MotionEvent) {
    for (i in 0 until ev.pointerCount) {
      if (isPenTool(ev.getToolType(i))) {
        notePen(ev, i)
        firePenButton(penButtonPressed(ev, i))
      }
    }
    val l = live ?: return
    val idx = ev.findPointerIndex(l.pointerId)
    if (idx < 0) return
    if (!l.isPen && ev.getToolType(idx) == MotionEvent.TOOL_TYPE_FINGER && palmSizeExceeded(ev, idx)) {
      retract("palm-size") // the contact grew into a palm; keep swallowing it
      return
    }
    for (h in 0 until ev.historySize) addPoint(l, point(ev, idx, h, l))
    addPoint(l, point(ev, idx, -1, l))
    l.predicted = emptyList()
    if (l.kind == "ink") {
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

  private fun finish(ev: MotionEvent, idx: Int, l: Live) {
    addPoint(l, point(ev, idx, -1, l))
    live = null
    when (l.kind) {
      "erase" -> {
        emitErase(l, final = true)
        layer.drawFrame(null)
      }
      "lasso" -> {
        if (l.points.size >= 3) onLasso(mapOf("polygon" to l.points.map { mapOf("x" to it.x, "y" to it.y) }))
        layer.drawFrame(null)
      }
      else -> {
        val id = UUID.randomUUID().toString()
        val last = l.points.last()
        val heldMs = max(0.0, max(last.t, (ev.eventTime - l.downTime).toDouble()) - l.holdT)
        val path = QalmFreehand.toPath(QalmFreehand.outline(l.tool, l.width, l.points))
        synchronized(pending) { pending.add(Pending(id, path, l.colorInt, alphaFor(l.tool))) }
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
          ),
        )
      }
    }
  }

  private fun retract(reason: String) {
    live = null
    layer.drawFrame(null)
    reject(reason)
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
    if (tool == "none" || !isPenTool(ev.getToolType(0))) return super.onHoverEvent(ev)
    notePen(ev, 0)
    firePenButton(penButtonPressed(ev, 0))
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
  )

  private fun alphaFor(tool: String) = if (tool == "highlighter") Math.round(HIGHLIGHTER_ALPHA * 255).toInt() else 255

  private fun render(l: Live) {
    val frame = when (l.kind) {
      "ink" -> Frame(
        fill = QalmFreehand.toPath(QalmFreehand.outline(l.tool, l.width, l.points + l.predicted)),
        fillColor = l.colorInt,
        fillAlpha = alphaFor(l.tool),
      )
      "lasso" -> Frame(
        lasso = Path().apply {
          l.points.forEachIndexed { i, p -> if (i == 0) moveTo(p.x.toFloat(), p.y.toFloat()) else lineTo(p.x.toFloat(), p.y.toFloat()) }
          close()
        },
      )
      else -> l.points.lastOrNull()?.let { Frame(cursor = doubleArrayOf(it.x, it.y, l.width / 2), cursorColor = ERASER_CURSOR) } ?: Frame()
    }
    layer.drawFrame(frame)
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

  /** Runs on the render thread (front-buffered) or the UI thread (fallback). */
  private fun paintPending(canvas: Canvas, sx: Float, sy: Float) {
    val snapshot = synchronized(pending) { pending.toList() }
    canvas.save()
    canvas.scale(sx, sy)
    for (p in snapshot) {
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
    val px = 1f / sx // one view px in page units
    frame.lasso?.let {
      linePaint.color = LASSO_COLOR
      linePaint.alpha = 255
      linePaint.strokeWidth = 1.5f * resources.displayMetrics.density * px
      linePaint.pathEffect = DashPathEffect(floatArrayOf(6f * resources.displayMetrics.density * px, 4f * resources.displayMetrics.density * px), 0f)
      canvas.drawPath(it, linePaint)
      linePaint.pathEffect = null
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
    // Tech-spec §3 palm rejection. Distances are mm, converted with DisplayMetrics.xdpi (px → mm = 25.4 / xdpi).
    // 1. Pen always draws; with drawWith = "pen" fingers never draw (they are left to scroll / zoom).
    // 2. A finger whose touchMajor exceeds PALM_MAJOR_MM[palm] is rejected.
    // 3. A finger within PEN_LOCKOUT_MS of any pen activity (contact or hover) is rejected; a finger beside or
    //    below the last pen position on the `hand` side (more than HAND_SIDE_MARGIN_MM past it does not count)
    //    is rejected while the pen was seen within HAND_SIDE_WINDOW_MS.
    // 4. ACTION_CANCEL / FLAG_CANCELED retracts the stroke in progress.
    val PALM_MAJOR_MM = mapOf("relaxed" to 9.0, "standard" to 7.0, "strict" to 5.0)
    const val PEN_LOCKOUT_MS = 600L
    const val HAND_SIDE_WINDOW_MS = 3000L // same as iOS
    const val HAND_SIDE_MARGIN_MM = 10.0
    /** Movement below this counts as holding still (heldMs, for shape snapping). */
    const val HOLD_MOVE_MM = 1.0
    /** A finished stroke whose id never reaches committedIds is dropped after this (same as iOS). */
    const val PENDING_FALLBACK_MS = 4000L
    /** How long a finished stroke stays after its id is in committedIds (same as iOS). */
    const val HANDOFF_MS = 50L
    const val HIGHLIGHTER_ALPHA = 0.45
    const val FLAG_CANCELED = 0x20 // MotionEvent.FLAG_CANCELED (API 33)
    val LASSO_COLOR = Color.parseColor("#4338ca")
    val ERASER_CURSOR = Color.parseColor("#8b8b95")

    fun parseColor(s: String): Int = try {
      Color.parseColor(s)
    } catch (e: IllegalArgumentException) {
      Color.BLACK
    }
  }
}
