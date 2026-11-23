package app.qalm.ink

import android.view.MotionEvent
import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.max

/**
 * Which contacts draw: palm rejection and the touch state machine of [QalmInkView] (tech-spec §3), kept apart
 * from drawing so it can be tested with synthesized [MotionEvent]s. The view owns the stroke itself; this class
 * decides when one starts, moves, ends or is retracted, and when the overlay claims the gesture from its parents.
 *
 * 1. Pen input always draws. With `drawWith = "pen"` fingers never draw: they are left to scroll and zoom.
 * 2. A finger whose contact major axis (`getTouchMajor`, px → mm with `xdpi`) exceeds [PALM_MAJOR_MM] is a palm.
 * 3. A finger within [PEN_LOCKOUT_MS] of any pen activity (contact or hover) is rejected, and so is a finger
 *    beside or below the last pen position on the `hand` side while the pen was seen within [HAND_SIDE_WINDOW_MS].
 * 4. `ACTION_CANCEL` / `FLAG_CANCELED` retracts the stroke in progress, as do a second finger (a scroll or zoom)
 *    and a contact that grows into a palm.
 *
 * A rejected palm is swallowed (the overlay claims the gesture) so it never scrolls. A finger stroke claims the
 * gesture only after [FINGER_CLAIM_MS] or [FINGER_CLAIM_DP] of movement, like iOS: claiming cancels every
 * gesture-handler gesture (react-native-gesture-handler cancels its handlers when a child calls
 * `requestDisallowInterceptTouchEvent(true)`), so a second finger landing just after the first can still pinch.
 */
internal class InkInput(private val host: Host) {
  interface Host {
    /** Millimetres per view pixel. */
    val mmPerPx: Double
    /** Pixels per dp. */
    val density: Float
    /** Start a stroke for pointer [idx]; false if the current tool draws nothing. */
    fun start(ev: MotionEvent, idx: Int, isPen: Boolean, eraser: Boolean): Boolean
    fun move(ev: MotionEvent, idx: Int)
    fun finish(ev: MotionEvent, idx: Int)
    /** Drop the stroke in progress without committing it. */
    fun retract()
    fun rejected(reason: String)
    fun penButton()
    /** `parent.requestDisallowInterceptTouchEvent(disallow)`. */
    fun claim(disallow: Boolean)
  }

  var drawWith = "pen" // pen | any
  var hand = "right" // left | right
  var palm = "standard" // relaxed | standard | strict

  /** The pointer drawing the stroke in progress, or -1. */
  var livePointer = -1
    private set
  private var liveIsPen = false
  private var claimed = false
  private var downX = 0f
  private var downY = 0f
  private var downTime = 0L

  private var lastPenTime = Long.MIN_VALUE / 2
  private var lastPenX = 0f
  private var lastPenY = 0f
  private var buttonDown = false

  val drawing get() = livePointer >= 0

  fun onTouchEvent(ev: MotionEvent) {
    when (ev.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        // A new gesture: anything still live missed its UP / CANCEL.
        if (drawing) retract(null)
        onDown(ev, ev.actionIndex)
      }
      MotionEvent.ACTION_POINTER_DOWN -> onDown(ev, ev.actionIndex)
      MotionEvent.ACTION_MOVE -> onMove(ev)
      MotionEvent.ACTION_POINTER_UP, MotionEvent.ACTION_UP -> {
        val idx = ev.actionIndex
        if (isPenTool(ev.getToolType(idx))) {
          notePen(ev, idx)
          buttonDown = false
        }
        if (drawing && ev.getPointerId(idx) == livePointer) {
          // FLAG_CANCELED: the OS decided this pointer was accidental (palm). Retract instead of committing.
          if ((ev.flags and FLAG_CANCELED) != 0) {
            retract("cancelled")
          } else {
            livePointer = -1
            host.finish(ev, idx)
          }
        }
      }
      MotionEvent.ACTION_CANCEL -> if (drawing) retract("cancelled")
    }
  }

  /** A hovering pen counts as pen activity (lockout, hand side) and can press its button. */
  fun onHoverEvent(ev: MotionEvent) {
    notePen(ev, 0)
    firePenButton(penButtonPressed(ev, 0))
  }

  private fun onDown(ev: MotionEvent, idx: Int) {
    val toolType = ev.getToolType(idx)
    when {
      isPenTool(toolType) -> {
        notePen(ev, idx)
        val button = penButtonPressed(ev, idx)
        firePenButton(button)
        if (drawing && !liveIsPen) retract("pen-took-over") // the palm got there first
        if (!drawing) begin(ev, idx, isPen = true, eraser = button)
      }
      isFinger(toolType) -> {
        if (drawWith == "pen") return host.rejected("pen-only") // fingers scroll and zoom
        val palmReason = when {
          palmSizeExceeded(ev, idx) -> "palm-size"
          ev.eventTime - lastPenTime < PEN_LOCKOUT_MS -> "pen-lockout"
          handSide(ev.getX(idx), ev.getY(idx), ev.eventTime) -> "hand-side"
          else -> null
        }
        if (palmReason != null) {
          host.claim(true) // swallow the palm so it doesn't scroll the page
          return host.rejected(palmReason)
        }
        when {
          !drawing -> begin(ev, idx, isPen = false, eraser = false)
          liveIsPen -> host.rejected("pen-active")
          else -> {
            // A second finger: this is a scroll / zoom, not ink.
            retract("multi-touch")
            host.claim(false)
          }
        }
      }
      else -> if (!drawing) begin(ev, idx, isPen = false, eraser = false) // mouse
    }
  }

  private fun begin(ev: MotionEvent, idx: Int, isPen: Boolean, eraser: Boolean) {
    if (!host.start(ev, idx, isPen, eraser)) return
    livePointer = ev.getPointerId(idx)
    liveIsPen = isPen
    downX = ev.getX(idx)
    downY = ev.getY(idx)
    downTime = ev.eventTime
    claimed = isFinger(ev.getToolType(idx)).not()
    if (claimed) host.claim(true)
  }

  private fun onMove(ev: MotionEvent) {
    for (i in 0 until ev.pointerCount) {
      if (isPenTool(ev.getToolType(i))) {
        notePen(ev, i)
        firePenButton(penButtonPressed(ev, i))
      }
    }
    if (!drawing) return
    val idx = ev.findPointerIndex(livePointer)
    if (idx < 0) return
    if (!liveIsPen && isFinger(ev.getToolType(idx))) {
      if (palmSizeExceeded(ev, idx)) {
        retract("palm-size") // the contact grew into a palm; keep swallowing it
        host.claim(true)
        return
      }
      if (!claimed &&
        (ev.eventTime - downTime >= FINGER_CLAIM_MS ||
          hypot(ev.getX(idx) - downX, ev.getY(idx) - downY) >= FINGER_CLAIM_DP * host.density)
      ) {
        claimed = true
        host.claim(true)
      }
    }
    host.move(ev, idx)
  }

  private fun retract(reason: String?) {
    livePointer = -1
    host.retract()
    if (reason != null) host.rejected(reason)
  }

  private fun notePen(ev: MotionEvent, idx: Int) {
    lastPenTime = ev.eventTime
    lastPenX = ev.getX(idx)
    lastPenY = ev.getY(idx)
  }

  private fun penButtonPressed(ev: MotionEvent, idx: Int): Boolean =
    ev.getToolType(idx) == MotionEvent.TOOL_TYPE_ERASER ||
      (ev.buttonState and (MotionEvent.BUTTON_STYLUS_PRIMARY or MotionEvent.BUTTON_STYLUS_SECONDARY)) != 0

  private fun firePenButton(pressed: Boolean) {
    if (pressed && !buttonDown) host.penButton()
    buttonDown = pressed
  }

  private fun palmSizeExceeded(ev: MotionEvent, idx: Int) =
    ev.getTouchMajor(idx) * host.mmPerPx > (PALM_MAJOR_MM[palm] ?: PALM_MAJOR_MM.getValue("standard"))

  private fun handSide(x: Float, y: Float, time: Long): Boolean {
    if (time - lastPenTime > HAND_SIDE_WINDOW_MS) return false
    val margin = HAND_SIDE_MARGIN_MM / host.mmPerPx
    val dx = x - lastPenX
    val dy = y - lastPenY
    val beside = if (hand == "left") dx < margin else dx > -margin
    return beside && dy > -margin
  }

  companion object {
    val PALM_MAJOR_MM = mapOf("relaxed" to 9.0, "standard" to 7.0, "strict" to 5.0)
    const val PEN_LOCKOUT_MS = 600L
    const val HAND_SIDE_WINDOW_MS = 3000L // same as iOS
    const val HAND_SIDE_MARGIN_MM = 10.0
    /** A finger stroke claims the gesture after this long, or after [FINGER_CLAIM_DP] of movement (iOS: 80 ms, 3 pt). */
    const val FINGER_CLAIM_MS = 80L
    const val FINGER_CLAIM_DP = 3f
    const val FLAG_CANCELED = 0x20 // MotionEvent.FLAG_CANCELED (API 33)

    fun isPenTool(t: Int) = t == MotionEvent.TOOL_TYPE_STYLUS || t == MotionEvent.TOOL_TYPE_ERASER
    fun isFinger(t: Int) = t == MotionEvent.TOOL_TYPE_FINGER || t == MotionEvent.TOOL_TYPE_UNKNOWN

    /**
     * Millimetres per px from the panel's `xdpi`. Some devices (and emulator skins) report an `xdpi` that has
     * nothing to do with the panel, which would make every contact look like a palm or none at all; when it is
     * more than 1.5× off the density bucket, trust the bucket instead.
     */
    fun mmPerPx(xdpi: Float, densityDpi: Int): Double {
      val bucket = max(1, densityDpi).toDouble()
      val dpi = if (xdpi.isFinite() && xdpi > 0 && abs(xdpi / bucket - 1) <= 0.5) xdpi.toDouble() else bucket
      return 25.4 / dpi
    }
  }
}
