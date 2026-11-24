package app.qalm.ink

import android.view.InputDevice
import android.view.MotionEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Palm rejection (tech-spec §3) driven by synthesized MotionEvents: tool types, TOUCH_MAJOR in px (converted with
 * xdpi), pen lockout, hand side, a second finger (retracting a stroke that just started, keeping one that was
 * drawing), FLAG_CANCELED and "pen seen", for relaxed / standard / strict.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class InkInputTest {
  private val xdpi = 320f // a typical tablet panel
  private val mmPerPx = 25.4 / xdpi
  private fun mm(v: Double) = (v / mmPerPx).toFloat()

  private val log = ArrayList<String>()
  private var startResult = true
  private var penSeen = 0
  private lateinit var input: InkInput

  private val host = object : InkInput.Host {
    override val mmPerPx get() = this@InkInputTest.mmPerPx
    override fun start(ev: MotionEvent, idx: Int, isPen: Boolean, eraser: Boolean): Boolean {
      log += "start ${ev.getPointerId(idx)} ${if (isPen) "pen" else "touch"}${if (eraser) " eraser" else ""}"
      return startResult
    }
    override fun move(ev: MotionEvent, idx: Int) { log += "move ${ev.getPointerId(idx)}" }
    override fun finish(ev: MotionEvent, idx: Int) { log += "finish ${ev.getPointerId(idx)}" }
    override fun retract() { log += "retract" }
    override fun rejected(reason: String) { log += "reject $reason" }
    override fun penButton() { log += "button" }
    override fun claim(disallow: Boolean) { log += "claim $disallow" }
    override fun holdScroll(hold: Boolean) { log += "hold $hold" }
    override fun penSeen() { penSeen++ }
  }

  @Before
  fun setUp() {
    input = InkInput(host).apply { drawWith = "any"; hand = "right"; palm = "standard" }
  }

  // ---- synthesized events ----
  private class P(val id: Int, val tool: Int, val x: Float, val y: Float, val major: Float = 0f)

  private fun finger(id: Int, x: Float, y: Float, majorMm: Double = 9.0) = P(id, MotionEvent.TOOL_TYPE_FINGER, x, y, mm(majorMm))
  private fun pen(id: Int, x: Float, y: Float) = P(id, MotionEvent.TOOL_TYPE_STYLUS, x, y, mm(0.5))

  private fun event(t: Long, action: Int, ps: List<P>, actionIndex: Int = 0, flags: Int = 0, buttons: Int = 0): MotionEvent {
    val props = ps.map { p -> MotionEvent.PointerProperties().apply { id = p.id; toolType = p.tool } }.toTypedArray()
    val coords = ps.map { p ->
      MotionEvent.PointerCoords().apply { x = p.x; y = p.y; pressure = 0.5f; touchMajor = p.major; touchMinor = p.major; size = 0.1f }
    }.toTypedArray()
    val masked = if (action == MotionEvent.ACTION_POINTER_DOWN || action == MotionEvent.ACTION_POINTER_UP) {
      action or (actionIndex shl MotionEvent.ACTION_POINTER_INDEX_SHIFT)
    } else action
    val source = if (ps.any { it.tool == MotionEvent.TOOL_TYPE_STYLUS }) InputDevice.SOURCE_STYLUS else InputDevice.SOURCE_TOUCHSCREEN
    return MotionEvent.obtain(0L, t, masked, ps.size, props, coords, 0, buttons, 1f, 1f, 0, 0, source, flags)
  }

  private fun send(t: Long, action: Int, vararg ps: P, actionIndex: Int = 0, flags: Int = 0, buttons: Int = 0) {
    val ev = event(t, action, ps.toList(), actionIndex, flags, buttons)
    input.onTouchEvent(ev)
    ev.recycle()
  }

  private fun tap(t: Long, p: P) {
    send(t, MotionEvent.ACTION_DOWN, p)
    send(t + 10, MotionEvent.ACTION_UP, p)
  }

  /** A pen stroke that lifts at [upAt], at (x, y). */
  private fun penStroke(upAt: Long, x: Float, y: Float) {
    send(upAt - 200, MotionEvent.ACTION_DOWN, pen(0, x - 50, y))
    send(upAt - 100, MotionEvent.ACTION_MOVE, pen(0, x - 20, y))
    send(upAt, MotionEvent.ACTION_UP, pen(0, x, y))
  }

  // ---- mm conversion ----
  @Test
  fun mmPerPxUsesXdpiAndDistrustsBogusValues() {
    assertEquals(25.4 / 320, InkInput.mmPerPx(320f, 320), 1e-9)
    assertEquals(25.4 / 280, InkInput.mmPerPx(280f, 320), 1e-9) // a real panel between density buckets
    assertEquals(25.4 / 320, InkInput.mmPerPx(0f, 320), 1e-9)
    assertEquals(25.4 / 320, InkInput.mmPerPx(1000f, 320), 1e-9) // a skin reporting a nonsense density
    assertEquals(25.4 / 320, InkInput.mmPerPx(Float.NaN, 320), 1e-9)
  }

  // ---- 1. pen vs finger ----
  @Test
  fun penAlwaysDrawsAndClaimsAtOnce() {
    input.drawWith = "pen"
    send(1000, MotionEvent.ACTION_DOWN, pen(0, 100f, 100f))
    send(1010, MotionEvent.ACTION_MOVE, pen(0, 120f, 100f))
    send(1020, MotionEvent.ACTION_UP, pen(0, 140f, 100f))
    assertEquals(listOf("start 0 pen", "claim true", "move 0", "finish 0"), log)
  }

  @Test
  fun penOnlyLeavesFingersToScroll() {
    input.drawWith = "pen"
    send(1000, MotionEvent.ACTION_DOWN, finger(0, 100f, 100f))
    send(1010, MotionEvent.ACTION_MOVE, finger(0, 100f, 300f))
    send(1020, MotionEvent.ACTION_UP, finger(0, 100f, 400f))
    assertEquals(listOf("reject pen-only"), log) // never claimed: the ScrollView / pinch handler gets it
  }

  @Test
  fun aFingerStrokeHoldsScrollingFromTouchDownWithoutClaiming() {
    // A parent ScrollView can't steal a fast stroke whose first move is already past its touch slop, and the
    // gesture isn't claimed (that would stop the pinch).
    send(1000, MotionEvent.ACTION_DOWN, finger(0, 100f, 100f))
    send(1016, MotionEvent.ACTION_MOVE, finger(0, 160f, 100f))
    send(1032, MotionEvent.ACTION_UP, finger(0, 220f, 100f))
    assertEquals(listOf("start 0 touch", "hold true", "move 0", "hold false", "finish 0"), log)
  }

  @Test
  fun aSecondFingerIsAPinchOrScrollNotInk() {
    send(1000, MotionEvent.ACTION_DOWN, finger(0, 100f, 100f))
    send(1030, MotionEvent.ACTION_POINTER_DOWN, finger(0, 100f, 100f), finger(1, 400f, 400f), actionIndex = 1)
    send(1040, MotionEvent.ACTION_MOVE, finger(0, 90f, 90f), finger(1, 420f, 420f))
    assertEquals(listOf("start 0 touch", "hold true", "hold false", "retract", "reject multi-touch", "claim false"), log)
    assertFalse(input.drawing)
  }

  @Test
  fun aSecondFingerAfterTheStrokeWasDrawingKeepsItAndPans() {
    send(1000, MotionEvent.ACTION_DOWN, finger(0, 100f, 100f))
    send(1100, MotionEvent.ACTION_MOVE, finger(0, 100f + mm(5.0), 100f))
    send(1200, MotionEvent.ACTION_MOVE, finger(0, 100f + mm(10.0), 100f))
    send(1210, MotionEvent.ACTION_POINTER_DOWN, finger(0, 100f + mm(10.0), 100f), finger(1, 400f, 400f), actionIndex = 1)
    send(1220, MotionEvent.ACTION_MOVE, finger(0, 90f, 90f), finger(1, 420f, 420f))
    send(1230, MotionEvent.ACTION_POINTER_UP, finger(0, 90f, 90f), finger(1, 420f, 420f), actionIndex = 1)
    send(1240, MotionEvent.ACTION_UP, finger(0, 80f, 80f))
    // Committed where the second finger landed; the rest of the gesture is the ScrollView's and the pinch's.
    assertEquals(listOf("start 0 touch", "hold true", "move 0", "move 0", "hold false", "finish 0", "claim false"), log)
    assertFalse(input.drawing)
  }

  @Test
  fun aSecondFingerRetractsAStrokeThatHasNotGoneAnywhere() {
    // Long enough, but hardly moved: one finger rested, then the other landed for a pinch.
    send(1000, MotionEvent.ACTION_DOWN, finger(0, 100f, 100f))
    send(1300, MotionEvent.ACTION_MOVE, finger(0, 100f + mm(2.0), 100f))
    send(1400, MotionEvent.ACTION_POINTER_DOWN, finger(0, 100f + mm(2.0), 100f), finger(1, 400f, 400f), actionIndex = 1)
    assertEquals(listOf("start 0 touch", "hold true", "move 0", "hold false", "retract", "reject multi-touch", "claim false"), log)
  }

  @Test
  fun aSecondFingerWithin150msRetractsEvenAFastStroke() {
    send(1000, MotionEvent.ACTION_DOWN, finger(0, 100f, 100f))
    send(1100, MotionEvent.ACTION_MOVE, finger(0, 100f + mm(20.0), 100f))
    send(1149, MotionEvent.ACTION_POINTER_DOWN, finger(0, 100f + mm(20.0), 100f), finger(1, 400f, 400f), actionIndex = 1)
    assertEquals(listOf("start 0 touch", "hold true", "move 0", "hold false", "retract", "reject multi-touch", "claim false"), log)
  }

  @Test
  fun penSeenIsReportedOnceForAContactOrAHover() {
    tap(1000, finger(0, 10f, 10f))
    assertEquals(0, penSeen)
    val hover = event(2000, MotionEvent.ACTION_HOVER_MOVE, listOf(pen(0, 500f, 500f)))
    input.onHoverEvent(hover)
    hover.recycle()
    penStroke(upAt = 3000, x = 500f, y = 500f)
    assertEquals(1, penSeen)
  }

  @Test
  fun mouseDraws() {
    send(1000, MotionEvent.ACTION_DOWN, P(0, MotionEvent.TOOL_TYPE_MOUSE, 10f, 10f))
    send(1010, MotionEvent.ACTION_UP, P(0, MotionEvent.TOOL_TYPE_MOUSE, 20f, 10f))
    assertEquals(listOf("start 0 touch", "claim true", "finish 0"), log)
  }

  @Test
  fun noToolMeansNoStroke() {
    startResult = false
    send(1000, MotionEvent.ACTION_DOWN, pen(0, 10f, 10f))
    send(1010, MotionEvent.ACTION_UP, pen(0, 20f, 10f))
    assertEquals(listOf("start 0 pen"), log)
    assertFalse(input.drawing)
  }

  // ---- 2. contact size, per level ----
  private fun drawsWith(palm: String, majorMm: Double): Boolean {
    log.clear()
    input = InkInput(host).apply { drawWith = "any"; this.palm = palm }
    send(100_000, MotionEvent.ACTION_DOWN, finger(0, 300f, 300f, majorMm))
    val drew = input.drawing
    send(100_010, MotionEvent.ACTION_UP, finger(0, 300f, 300f, majorMm))
    if (!drew) assertEquals(listOf("claim true", "reject palm-size"), log) // swallowed: a palm never scrolls
    return drew
  }

  @Test
  fun palmThresholdsInMillimetres() {
    assertTrue(drawsWith("relaxed", 29.8))
    assertFalse(drawsWith("relaxed", 30.3))
    assertTrue(drawsWith("standard", 19.8))
    assertFalse(drawsWith("standard", 20.3))
    assertTrue(drawsWith("strict", 13.8))
    assertFalse(drawsWith("strict", 14.3))
    // fingertips (7–12 mm) draw at every level
    for (level in listOf("relaxed", "standard", "strict")) for (mm in listOf(7.0, 8.0, 10.0, 12.0)) assertTrue("$level $mm", drawsWith(level, mm))
    // palms (20–40 mm) are rejected at standard
    for (mm in listOf(22.0, 25.0, 30.0, 40.0)) assertFalse("standard $mm", drawsWith("standard", mm))
    // a flat finger or palm edge (15–18 mm) only at strict
    for (mm in listOf(15.0, 16.5, 18.0)) {
      assertFalse("strict $mm", drawsWith("strict", mm))
      assertTrue("standard $mm", drawsWith("standard", mm))
      assertTrue("relaxed $mm", drawsWith("relaxed", mm))
    }
    // an unknown level falls back to standard
    assertFalse(drawsWith("bogus", 21.0))
  }

  @Test
  fun unknownToolTypeIsTreatedAsAFinger() {
    input.drawWith = "pen"
    send(1000, MotionEvent.ACTION_DOWN, P(0, MotionEvent.TOOL_TYPE_UNKNOWN, 10f, 10f))
    assertEquals(listOf("reject pen-only"), log)
  }

  @Test
  fun aContactThatGrowsIntoAPalmIsRetracted() {
    send(1000, MotionEvent.ACTION_DOWN, finger(0, 100f, 100f, 9.0))
    send(1010, MotionEvent.ACTION_MOVE, finger(0, 110f, 100f, 12.0))
    send(1020, MotionEvent.ACTION_MOVE, finger(0, 120f, 100f, 28.0))
    send(1030, MotionEvent.ACTION_MOVE, finger(0, 130f, 100f, 28.0))
    send(1040, MotionEvent.ACTION_UP, finger(0, 140f, 100f, 28.0))
    assertEquals(listOf("start 0 touch", "hold true", "move 0", "hold false", "retract", "reject palm-size", "claim true"), log)
  }

  @Test
  fun aPalmLandingBesideAFingerStrokeDoesNotEndIt() {
    send(1000, MotionEvent.ACTION_DOWN, finger(0, 100f, 100f))
    send(1100, MotionEvent.ACTION_MOVE, finger(0, 120f, 100f))
    send(1110, MotionEvent.ACTION_POINTER_DOWN, finger(0, 120f, 100f), finger(1, 500f, 500f, 30.0), actionIndex = 1)
    send(1120, MotionEvent.ACTION_MOVE, finger(0, 140f, 100f), finger(1, 500f, 500f, 30.0))
    send(1130, MotionEvent.ACTION_POINTER_UP, finger(0, 140f, 100f), finger(1, 500f, 500f, 30.0), actionIndex = 1)
    send(1140, MotionEvent.ACTION_UP, finger(0, 150f, 100f))
    assertEquals(
      listOf("start 0 touch", "hold true", "move 0", "claim true", "reject palm-size", "move 0", "hold false", "finish 0"),
      log,
    )
  }

  // ---- 3. pen lockout and hand side ----
  @Test
  fun penLockoutIs600ms() {
    penStroke(upAt = 10_000, x = 500f, y = 500f)
    log.clear()
    val farAway = finger(1, 100f, 100f) // left of and above the pen: not the hand side
    send(10_599, MotionEvent.ACTION_DOWN, farAway)
    assertEquals(listOf("claim true", "reject pen-lockout"), log)
    send(10_605, MotionEvent.ACTION_UP, farAway)
    log.clear()
    send(10_601, MotionEvent.ACTION_DOWN, farAway)
    assertTrue(input.drawing)
  }

  @Test
  fun aHoveringPenCountsAsPenActivity() {
    val hover = event(20_000, MotionEvent.ACTION_HOVER_MOVE, listOf(pen(0, 500f, 500f)))
    input.onHoverEvent(hover)
    hover.recycle()
    send(20_300, MotionEvent.ACTION_DOWN, finger(1, 100f, 100f))
    assertEquals(listOf("claim true", "reject pen-lockout"), log)
  }

  @Test
  fun rightHandSideIsBesideOrBelowThePenFor2s() {
    penStroke(upAt = 10_000, x = 500f, y = 500f)
    log.clear()
    tap(10_700, finger(1, 700f, 700f)) // below right
    tap(11_000, finger(1, 480f, 900f)) // below, a little left (within 10 mm)
    tap(11_500, finger(1, 900f, 500f - mm(5.0))) // beside, slightly above
    assertEquals(List(3) { listOf("claim true", "reject hand-side") }.flatten(), log)
    log.clear()
    tap(11_600, finger(1, 500f - mm(15.0), 900f)) // below but clearly left of the pen
    tap(11_700, finger(1, 900f, 500f - mm(15.0))) // right but clearly above
    assertEquals(List(2) { listOf("start 1 touch", "hold true", "hold false", "finish 1") }.flatten(), log)
    log.clear()
    tap(11_950, finger(1, 700f, 700f)) // below right, still within 2 s
    assertEquals(listOf("claim true", "reject hand-side"), log)
    log.clear()
    tap(12_001, finger(1, 700f, 700f)) // the pen hasn't been seen for over 2 s
    assertEquals(listOf("start 1 touch", "hold true", "hold false", "finish 1"), log)
  }

  @Test
  fun leftHandSideIsMirrored() {
    input.hand = "left"
    penStroke(upAt = 10_000, x = 500f, y = 500f)
    log.clear()
    tap(10_700, finger(1, 300f, 700f)) // below left
    assertEquals(listOf("claim true", "reject hand-side"), log)
    log.clear()
    tap(10_800, finger(1, 700f, 700f)) // below right: fine for a left-hander
    assertEquals(listOf("start 1 touch", "hold true", "hold false", "finish 1"), log)
  }

  @Test
  fun aFingerWhileThePenIsDownNeverDraws() {
    send(10_000, MotionEvent.ACTION_DOWN, pen(0, 500f, 500f))
    // the pen held still for 0.7 s, then a finger far up-left (outside the lockout and hand side)
    send(10_700, MotionEvent.ACTION_POINTER_DOWN, pen(0, 500f, 500f), finger(1, 100f, 100f), actionIndex = 1)
    send(10_710, MotionEvent.ACTION_MOVE, pen(0, 510f, 500f), finger(1, 100f, 120f))
    send(10_720, MotionEvent.ACTION_POINTER_UP, pen(0, 510f, 500f), finger(1, 100f, 120f), actionIndex = 1)
    send(10_730, MotionEvent.ACTION_UP, pen(0, 520f, 500f))
    assertEquals(listOf("start 0 pen", "claim true", "reject pen-active", "move 0", "finish 0"), log)
  }

  @Test
  fun thePenTakesOverFromAPalmThatGotThereFirst() {
    send(10_000, MotionEvent.ACTION_DOWN, finger(0, 600f, 600f, 10.0))
    send(10_030, MotionEvent.ACTION_POINTER_DOWN, finger(0, 600f, 600f, 10.0), pen(1, 500f, 500f), actionIndex = 1)
    send(10_040, MotionEvent.ACTION_MOVE, finger(0, 600f, 600f, 10.0), pen(1, 520f, 500f))
    send(10_050, MotionEvent.ACTION_POINTER_UP, finger(0, 600f, 600f, 10.0), pen(1, 530f, 500f), actionIndex = 1)
    assertEquals(
      listOf("start 0 touch", "hold true", "hold false", "retract", "reject pen-took-over", "start 1 pen", "claim true", "move 1", "finish 1"),
      log,
    )
  }

  // ---- 4. cancellation ----
  @Test
  fun actionCancelRetracts() {
    send(1000, MotionEvent.ACTION_DOWN, pen(0, 100f, 100f))
    send(1010, MotionEvent.ACTION_CANCEL, pen(0, 110f, 100f))
    assertEquals(listOf("start 0 pen", "claim true", "retract", "reject cancelled"), log)
  }

  @Test
  fun flagCanceledOnUpRetractsInsteadOfCommitting() {
    send(1000, MotionEvent.ACTION_DOWN, finger(0, 100f, 100f))
    send(1100, MotionEvent.ACTION_UP, finger(0, 110f, 100f), flags = InkInput.FLAG_CANCELED)
    assertEquals(listOf("start 0 touch", "hold true", "hold false", "retract", "reject cancelled"), log)
  }

  @Test
  fun flagCanceledOnPointerUpRetractsOnlyTheLiveStroke() {
    send(1000, MotionEvent.ACTION_DOWN, pen(0, 100f, 100f))
    send(1010, MotionEvent.ACTION_POINTER_DOWN, pen(0, 100f, 100f), finger(1, 900f, 900f, 30.0), actionIndex = 1)
    // the OS cancels the palm (not the live pointer): the pen stroke goes on
    send(1020, MotionEvent.ACTION_POINTER_UP, pen(0, 110f, 100f), finger(1, 900f, 900f, 30.0), actionIndex = 1, flags = InkInput.FLAG_CANCELED)
    assertTrue(input.drawing)
    // now the pen itself is cancelled
    send(1030, MotionEvent.ACTION_POINTER_DOWN, pen(0, 110f, 100f), finger(1, 900f, 900f), actionIndex = 1)
    send(1040, MotionEvent.ACTION_POINTER_UP, pen(0, 120f, 100f), finger(1, 900f, 900f), actionIndex = 0, flags = InkInput.FLAG_CANCELED)
    assertFalse(input.drawing)
    assertEquals("reject cancelled", log.last())
  }

  @Test
  fun aNewGestureDropsAStrokeThatMissedItsUp() {
    send(1000, MotionEvent.ACTION_DOWN, pen(0, 100f, 100f))
    send(5000, MotionEvent.ACTION_DOWN, pen(0, 300f, 300f))
    assertEquals(listOf("start 0 pen", "claim true", "retract", "start 0 pen", "claim true"), log)
  }

  @Test
  fun detachingMidStrokeGivesTheScrollViewsBack() {
    send(1000, MotionEvent.ACTION_DOWN, finger(0, 100f, 100f))
    input.reset()
    input.reset()
    assertEquals(listOf("start 0 touch", "hold true", "hold false"), log)
    assertFalse(input.drawing)
  }

  // ---- pen only: fingers scroll, palms never do ----
  @Test
  fun penOnlySwallowsAPalmSoItNeverScrolls() {
    input.drawWith = "pen"
    send(1000, MotionEvent.ACTION_DOWN, finger(0, 300f, 300f, 40.0))
    send(1010, MotionEvent.ACTION_MOVE, finger(0, 300f, 200f, 40.0))
    send(1020, MotionEvent.ACTION_UP, finger(0, 300f, 100f, 40.0))
    assertEquals(listOf("claim true", "reject palm-size"), log)
    assertFalse(input.drawing)
  }

  @Test
  fun penOnlyAFingerRightAfterThePenDoesNotScroll() {
    input.drawWith = "pen"
    penStroke(upAt = 10_000, x = 500f, y = 500f)
    log.clear()
    tap(10_300, finger(1, 100f, 100f)) // left of and above the pen: only the lockout applies
    tap(11_000, finger(1, 700f, 700f)) // below right: the writing hand
    assertEquals(listOf("claim true", "reject pen-lockout", "claim true", "reject hand-side"), log)
    log.clear()
    tap(11_100, finger(1, 100f, 100f)) // later and away from the hand: it scrolls
    assertEquals(listOf("reject pen-only"), log)
  }

  @Test
  fun penOnlyAFingerWhileThePenWritesDoesNotDrawOrUnclaim() {
    input.drawWith = "pen"
    send(10_000, MotionEvent.ACTION_DOWN, pen(0, 500f, 500f))
    send(10_700, MotionEvent.ACTION_POINTER_DOWN, pen(0, 500f, 500f), finger(1, 100f, 100f), actionIndex = 1)
    send(10_710, MotionEvent.ACTION_MOVE, pen(0, 510f, 500f), finger(1, 100f, 120f))
    assertEquals(listOf("start 0 pen", "claim true", "reject pen-active", "move 0"), log)
  }

  @Test
  fun penOnlyTwoFingersAreLeftToZoom() {
    input.drawWith = "pen"
    send(1000, MotionEvent.ACTION_DOWN, finger(0, 300f, 300f))
    send(1010, MotionEvent.ACTION_POINTER_DOWN, finger(0, 300f, 300f), finger(1, 500f, 300f), actionIndex = 1)
    send(1020, MotionEvent.ACTION_MOVE, finger(0, 250f, 300f), finger(1, 550f, 300f))
    assertEquals(listOf("reject pen-only", "reject pen-only"), log) // never claimed: the pinch handler gets it
  }

  // ---- pen button ----
  @Test
  fun theBarrelButtonHeldWhileWritingErasesOnlyThatStroke() {
    val held = MotionEvent.BUTTON_STYLUS_PRIMARY
    send(1000, MotionEvent.ACTION_DOWN, pen(0, 100f, 100f), buttons = held)
    send(1010, MotionEvent.ACTION_MOVE, pen(0, 110f, 100f), buttons = held)
    send(1020, MotionEvent.ACTION_UP, pen(0, 120f, 100f))
    // still held as the pen lifts and hovers: not a new press
    hover(1100, buttons = held)
    // the next stroke, without the button, draws with the tool again
    send(2000, MotionEvent.ACTION_DOWN, pen(0, 100f, 100f))
    send(2010, MotionEvent.ACTION_UP, pen(0, 120f, 100f))
    assertEquals(listOf("start 0 pen eraser", "claim true", "move 0", "finish 0", "start 0 pen", "claim true", "finish 0"), log)
  }

  @Test
  fun pressingTheButtonMidStrokeDoesNotSwitchTools() {
    send(1000, MotionEvent.ACTION_DOWN, pen(0, 100f, 100f))
    send(1010, MotionEvent.ACTION_MOVE, pen(0, 110f, 100f), buttons = MotionEvent.BUTTON_STYLUS_PRIMARY)
    send(1020, MotionEvent.ACTION_UP, pen(0, 120f, 100f))
    assertEquals(listOf("start 0 pen", "claim true", "move 0", "finish 0"), log)
  }

  @Test
  fun theButtonPressedWhileHoveringIsTheShortcut() {
    hover(1000)
    hover(1010, buttons = MotionEvent.BUTTON_STYLUS_PRIMARY)
    hover(1020, buttons = MotionEvent.BUTTON_STYLUS_PRIMARY) // held: fires once
    hover(1030)
    hover(1040, buttons = MotionEvent.BUTTON_STYLUS_SECONDARY)
    assertEquals(listOf("button", "button"), log)
  }

  @Test
  fun theEraserEndErasesWithoutSwitchingTools() {
    val eraserEnd = P(0, MotionEvent.TOOL_TYPE_ERASER, 100f, 100f)
    val hover = event(900, MotionEvent.ACTION_HOVER_MOVE, listOf(eraserEnd))
    input.onHoverEvent(hover)
    hover.recycle()
    send(1000, MotionEvent.ACTION_DOWN, eraserEnd)
    send(1010, MotionEvent.ACTION_UP, eraserEnd)
    assertEquals(listOf("start 0 pen eraser", "claim true", "finish 0"), log)
  }

  private fun hover(t: Long, buttons: Int = 0) {
    val ev = event(t, MotionEvent.ACTION_HOVER_MOVE, listOf(pen(0, 500f, 500f)), buttons = buttons)
    input.onHoverEvent(ev)
    ev.recycle()
  }
}
