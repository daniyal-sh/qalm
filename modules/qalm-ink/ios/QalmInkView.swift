import ExpoModulesCore
import UIKit

/// InkOverlay (tech-spec §3): a transparent view stacked over PageCanvas. It takes the input and draws
/// ONLY the stroke in progress (plus finished strokes until their id shows up in `committedIds`).
/// Its laid-out size maps linearly onto `pageSize` (page units), so it needs no zoom state.
final class QalmInkView: ExpoView, UIGestureRecognizerDelegate, UIPencilInteractionDelegate {
  // MARK: Events
  let onStrokeEnd = EventDispatcher()
  let onErase = EventDispatcher()
  let onLasso = EventDispatcher()
  let onPenButton = EventDispatcher()
  let onRejectedTouch = EventDispatcher()
  let onShapeHold = EventDispatcher()
  let onPenSeen = EventDispatcher()

  // MARK: Tunables (spec §3; physical sizes in millimetres)
  private static let mmPerPoint = 0.19               // iPad point ≈ 0.19 mm
  private static let penLockout: TimeInterval = 0.6  // touches within 600 ms of pen activity are rejected
  private static let handSideWindow: TimeInterval = 2.0  // how long the last pen position guards the hand side
  private static let handSideMarginMm = 10.0         // "beside" tolerance around the pen tip
  private static let fingerClaimDelay: TimeInterval = 0.08  // a 2nd finger before this → scroll/zoom, not ink
  private static let fingerClaimDistance: CGFloat = 3       // points of movement that also claim a finger stroke
  // A second finger this soon after the first landed, or before the first travelled this far, retracts its stroke
  // (both were meant as a pan or pinch). Later, the stroke is kept and ends there. Same as Android and web.
  private static let secondFingerRetract: TimeInterval = 0.15
  private static let secondFingerRetractMm = 3.0
  private static let heldRadius = 2.0                // page units, for heldMs
  private static let pendingFallback: TimeInterval = 4.0   // drop an uncommitted finished stroke after this
  // committedIds arrive once Skia has its new picture; it shows it a frame or two later, so keep ours until then.
  private static let handoffDelay: TimeInterval = 0.05
  private static let useMultiplyForHighlighter = true
  private static let lassoColor = UIColor(red: 0x43 / 255.0, green: 0x38 / 255.0, blue: 0xca / 255.0, alpha: 1) // accent
  private static let eraserCursorColor = UIColor(red: 0x8b / 255.0, green: 0x8b / 255.0, blue: 0x95 / 255.0, alpha: 1) // faint

  // MARK: Props
  fileprivate enum Tool: String { case pen, highlighter, eraser, lasso, none }
  private var pageW = 0.0
  private var pageH = 0.0
  private var tool: Tool = .none
  private var colorString = "#27272a"
  private var color = UIColor(red: 0x27 / 255.0, green: 0x27 / 255.0, blue: 0x2a / 255.0, alpha: 1)
  private var strokeWidth = 1.8
  private var penStyle = "fountain"
  private var smoothing = 0
  private var lassoRect = false
  private var eraserPartial = false  // partial erase: show the eraser's recent trail
  private var drawWithPen = true
  private var rightHanded = true
  private var palmThresholdMm = 20.0
  private var committed = Set<String>()
  private var shapeSnap = false  // live shapes on: report holds (onShapeHold)

  // MARK: State
  fileprivate struct Pt {
    var x: Double, y: Double, p: Double, tilt: Double, az: Double, t: Double
  }

  fileprivate final class Active {
    let id = UUID().uuidString.lowercased()
    let touch: UITouch
    let isPencil: Bool
    let tool: Tool
    let colorString: String
    let color: UIColor
    let width: Double
    let style: String
    let smoothing: Int
    let start: TimeInterval
    let startLocation: CGPoint
    var lastLocation: CGPoint
    var travel: CGFloat = 0  // points the touch has moved
    var points: [Pt] = []
    var pendingEstimates: [NSNumber: Int] = [:]
    var erasedUpTo = 0  // eraser: points already emitted
    var claimToken = 0
    // Live shapes: where the hold began (page units, point index), the onShapeHold awaited (-1: none), and once
    // snapped the shape under the pen (`snapBase` as recognised, `snapCur` adjusted) and where the pen was then.
    var holdX = 0.0, holdY = 0.0
    var holdIdx = 0
    var holdRequest = -1
    var snapKind: String?
    var snapBase: [SIMD2<Double>] = []
    var snapCur: [SIMD2<Double>] = []
    var snapFrom = SIMD2<Double>(0, 0)
    init(touch: UITouch, isPencil: Bool, tool: Tool, colorString: String, color: UIColor, width: Double,
         style: String, smoothing: Int, location: CGPoint) {
      self.touch = touch
      self.isPencil = isPencil
      self.tool = tool
      self.colorString = colorString
      self.color = color
      self.width = width
      self.style = style
      self.smoothing = smoothing
      self.start = touch.timestamp
      self.startLocation = location
      self.lastLocation = location
    }
  }

  fileprivate struct Pending {
    let layer: CAShapeLayer
    let outline: [FHVec]
    /// A snapped shape: drawn as a stroked outline (kind, page-unit points, width) instead of `outline`.
    var shape: (kind: String, pts: [SIMD2<Double>], width: Double)? = nil
  }

  private var active: Active?
  private var pending: [String: Pending] = [:]
  private var lastPenTime: TimeInterval = -1_000_000
  private var lastPenLocation: CGPoint?
  private var claimCounter = 0
  private var holdCounter = 0
  private var holdWork: DispatchWorkItem?
  private var penReported = false
  /// Ancestor scroll views whose pan needs two fingers while a finger draws here ("pen and finger"), with the
  /// minimum they had before.
  private var heldScrollPans: [(UIPanGestureRecognizer, Int)] = []
  private static var lastPenButtonTime: TimeInterval = -1_000_000  // shared: every overlay on screen gets the pencil interaction

  // MARK: Layers
  private let strokesLayer = CALayer()      // pending (finished) strokes, then the live one on top
  private let liveLayer = CAShapeLayer()
  private let lassoLayer = CAShapeLayer()
  private let cursorLayer = CAShapeLayer()  // hover preview and eraser cursor
  private let trailLayer = CAShapeLayer()   // partial erase: where the eraser just went
  private static let eraseTrailMs = 250.0   // InkOverlay.types ERASE_TRAIL_MS

  private let inkGesture = InkGestureRecognizer(target: nil, action: nil)
  private var hoverGesture: UIHoverGestureRecognizer?

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    backgroundColor = .clear
    isOpaque = false
    clipsToBounds = true
    isMultipleTouchEnabled = true

    strokesLayer.masksToBounds = true
    layer.addSublayer(strokesLayer)
    for l in [liveLayer, lassoLayer, cursorLayer, trailLayer] {
      l.fillRule = .nonZero
      l.actions = ["path": NSNull(), "position": NSNull(), "bounds": NSNull(), "hidden": NSNull(),
                   "fillColor": NSNull(), "strokeColor": NSNull(), "opacity": NSNull()]
    }
    strokesLayer.addSublayer(liveLayer)
    lassoLayer.fillColor = nil
    lassoLayer.strokeColor = QalmInkView.lassoColor.cgColor
    lassoLayer.lineWidth = 1.5
    lassoLayer.lineDashPattern = [6, 4]
    lassoLayer.lineJoin = .round
    layer.addSublayer(lassoLayer)
    trailLayer.fillColor = nil
    trailLayer.strokeColor = QalmInkView.eraserCursorColor.withAlphaComponent(0.16).cgColor
    trailLayer.lineCap = .round
    trailLayer.lineJoin = .round
    layer.addSublayer(trailLayer)
    cursorLayer.isHidden = true
    layer.addSublayer(cursorLayer)

    inkGesture.inkView = self
    inkGesture.delegate = self
    inkGesture.cancelsTouchesInView = false
    inkGesture.delaysTouchesBegan = false
    inkGesture.delaysTouchesEnded = false
    addGestureRecognizer(inkGesture)

    let hover = UIHoverGestureRecognizer(target: self, action: #selector(handleHover(_:)))
    addGestureRecognizer(hover)
    hoverGesture = hover

    let pencil = UIPencilInteraction()
    pencil.delegate = self
    addInteraction(pencil)

    applyInputConfig()
  }

  // MARK: Prop setters

  func setPageSize(w: Double, h: Double) {
    pageW = w
    pageH = h
    rebuildAllPaths()
  }

  func setTool(_ value: String) {
    let next = Tool(rawValue: value) ?? .none
    if next == tool { return }
    tool = next
    applyInputConfig()
    cursorLayer.isHidden = true
  }

  func setColor(_ value: String) {
    colorString = value
    if let c = QalmInkView.parseColor(value) { color = c }
  }

  func setStrokeWidth(_ value: Double) {
    if value.isFinite && value > 0 { strokeWidth = value }
  }

  func setPenStyle(_ value: String) {
    penStyle = FreehandSettings.penStyles[value] != nil ? value : "fountain"
  }

  func setSmoothing(_ value: Int) {
    smoothing = (0...3).contains(value) ? value : 0
  }

  func setLassoMode(_ mode: String) {
    lassoRect = mode == "rect"
  }

  func setEraserMode(_ mode: String) {
    eraserPartial = mode == "partial"
  }

  func setInput(drawWith: String, hand: String, palm: String) {
    drawWithPen = drawWith != "any"
    rightHanded = hand != "left"
    switch palm {
    case "relaxed": palmThresholdMm = 30
    case "strict": palmThresholdMm = 14
    default: palmThresholdMm = 20
    }
    applyInputConfig()
  }

  func setShapeSnap(_ on: Bool) {
    shapeSnap = on
  }

  func setCommittedIds(_ ids: [String]) {
    committed = Set(ids)
    let done = pending.keys.filter { committed.contains($0) }
    if done.isEmpty { return }
    DispatchQueue.main.asyncAfter(deadline: .now() + QalmInkView.handoffDelay) { [weak self] in
      guard let self = self else { return }
      CATransaction.begin()
      CATransaction.setDisableActions(true)
      for id in done {
        self.pending[id]?.layer.removeFromSuperlayer()
        self.pending[id] = nil
      }
      CATransaction.commit()
    }
  }

  private func applyInputConfig() {
    inkGesture.isEnabled = tool != .none
    // Fingers reach the recognizer in "pen only" too, so a palm can be swallowed; the others are ignored and scroll.
    inkGesture.allowedTouchTypes = [UITouch.TouchType.pencil, .direct].map { NSNumber(value: $0.rawValue) }
  }

  // MARK: Layout

  override func layoutSubviews() {
    super.layoutSubviews()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    for l in [strokesLayer, liveLayer, lassoLayer, cursorLayer, trailLayer] {
      l.frame = bounds
    }
    let scale = window?.screen.scale ?? traitCollection.displayScale
    if scale > 0 {
      for l in [strokesLayer, liveLayer, lassoLayer, cursorLayer, trailLayer] { l.contentsScale = scale }
    }
    CATransaction.commit()
    rebuildAllPaths()
  }

  /// Points per page unit.
  private var sx: CGFloat { pageW > 0 ? bounds.width / CGFloat(pageW) : 0 }
  private var sy: CGFloat { pageH > 0 ? bounds.height / CGFloat(pageH) : 0 }

  private func rebuildAllPaths() {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    for (_, p) in pending {
      p.layer.frame = bounds
      if let s = p.shape {
        p.layer.path = shapePath(kind: s.kind, pts: s.pts)
        p.layer.lineWidth = CGFloat(s.width) * sx
      } else {
        p.layer.path = Freehand.path(from: p.outline, sx: sx, sy: sy)
      }
    }
    CATransaction.commit()
    if let a = active { render(a, predicted: []) }
  }

  // MARK: Touch input (called by InkGestureRecognizer)

  func inkTouchesBegan(_ touches: Set<UITouch>, event: UIEvent, recognizer: InkGestureRecognizer) {
    // Pencil first, so a pencil landing together with a palm wins.
    let ordered = touches.sorted { ($0.type == .pencil ? 0 : 1) < ($1.type == .pencil ? 0 : 1) }
    for touch in ordered {
      if touch.type == .pencil {
        notePen(touch)
        if let a = active {
          if a.isPencil { continue }
          retract(reason: "pen-took-over")
        }
        recognizer.claim()
        begin(touch, event: event, isPencil: true)
        continue
      }

      // Finger.
      if let reason = palmReason(touch) {
        reject(reason)
        recognizer.claim()  // swallow the palm so it doesn't scroll the page
        continue
      }
      if drawWithPen {
        // Pen only: fingers scroll and zoom, but not while the pen writes (it has already claimed the sequence).
        if let a = active, a.isPencil {
          reject("pen-active")
        } else {
          reject("pen-only")
          recognizer.ignoreTouch(touch, for: event)
        }
        continue
      }
      if let a = active {
        if a.isPencil {
          reject("pen-active")
          continue
        }
        // A second finger: this is a scroll/zoom, not ink. A stroke that has only just started is retracted; one
        // that was clearly drawing ends here and is kept. The two-finger scroll pan and the pinch take over.
        let young = touch.timestamp - a.start < QalmInkView.secondFingerRetract
          || Double(a.travel) * QalmInkView.mmPerPoint < QalmInkView.secondFingerRetractMm
        if young {
          retract(reason: "multi-touch")
        } else {
          finish(a)
        }
        recognizer.relinquish()
        return
      }
      begin(touch, event: event, isPencil: false)
      holdScrollPans()
      scheduleFingerClaim(recognizer)
    }
  }

  func inkTouchesMoved(_ touches: Set<UITouch>, event: UIEvent, recognizer: InkGestureRecognizer) {
    for touch in touches where touch.type == .pencil { notePen(touch) }
    guard let a = active, touches.contains(a.touch) else { return }
    if !a.isPencil {
      if palmSizeExceeded(a.touch) {
        retract(reason: "palm-size")
        recognizer.claim()  // keep swallowing the palm
        return
      }
      let loc = a.touch.location(in: self)
      a.travel += hypot(loc.x - a.lastLocation.x, loc.y - a.lastLocation.y)
      a.lastLocation = loc
      if hypot(loc.x - a.startLocation.x, loc.y - a.startLocation.y) >= QalmInkView.fingerClaimDistance {
        recognizer.claim()
      }
    }
    append(a, touch: a.touch, event: event)
    let predicted = (event.predictedTouches(for: a.touch) ?? []).map { makePoint($0, a) }
    render(a, predicted: predicted)
    if a.tool == .eraser { emitErase(a, isFinal: false) }
  }

  func inkTouchesEnded(_ touches: Set<UITouch>, event: UIEvent, recognizer: InkGestureRecognizer) {
    for touch in touches where touch.type == .pencil { notePen(touch) }
    guard let a = active, touches.contains(a.touch) else { return }
    append(a, touch: a.touch, event: event)
    finish(a)
  }

  func inkTouchesCancelled(_ touches: Set<UITouch>, event: UIEvent, recognizer: InkGestureRecognizer) {
    guard let a = active, touches.contains(a.touch) else { return }
    retract(reason: "cancelled")
  }

  func inkEstimatedPropertiesUpdated(_ touches: Set<UITouch>) {
    guard let a = active else { return }
    var changed = false
    for touch in touches {
      guard let idx = touch.estimationUpdateIndex, let i = a.pendingEstimates[idx], i < a.points.count else { continue }
      let fresh = makePoint(touch, a)
      a.points[i].p = fresh.p
      a.points[i].tilt = fresh.tilt
      a.points[i].az = fresh.az
      if touch.estimatedPropertiesExpectingUpdates.isEmpty { a.pendingEstimates[idx] = nil }
      changed = true
    }
    if changed { render(a, predicted: []) }
  }

  func inkRecognizerDidReset() {
    // All touches are gone. Anything still in progress lost its touch: retract it.
    if active != nil { retract(reason: "cancelled") }
    releaseScrollPans()
  }

  /// "Pen and finger": one finger draws, so while it is down the ancestor scroll views pan with two fingers only.
  /// The second finger then pans them natively (with momentum) and RNGH pinches; one finger never scrolls the page.
  /// Restored when the touch sequence ends, so elsewhere (and with the pen tool off) one finger scrolls as usual.
  private func holdScrollPans() {
    guard heldScrollPans.isEmpty else { return }
    var v = superview
    while let view = v {
      if let sv = view as? UIScrollView, sv.isScrollEnabled {
        let pan = sv.panGestureRecognizer
        heldScrollPans.append((pan, pan.minimumNumberOfTouches))
        pan.minimumNumberOfTouches = max(2, pan.minimumNumberOfTouches)
      }
      v = view.superview
    }
  }

  private func releaseScrollPans() {
    for (pan, minimum) in heldScrollPans { pan.minimumNumberOfTouches = minimum }
    heldScrollPans.removeAll()
  }

  override func willMove(toWindow newWindow: UIWindow?) {
    super.willMove(toWindow: newWindow)
    if newWindow == nil { releaseScrollPans() }
  }

  // MARK: Gesture delegate

  func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                         shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
    guard gestureRecognizer === inkGesture else { return false }
    if otherGestureRecognizer === hoverGesture { return true }
    // Finger ink keeps the parent's pinch alive, so a second finger can still zoom (we retract then).
    if let a = active, a.isPencil { return false }
    // …and the scroll views' pan, which waits for a second finger while a finger draws (holdScrollPans).
    if active != nil, !heldScrollPans.isEmpty, let pan = otherGestureRecognizer as? UIPanGestureRecognizer,
       heldScrollPans.contains(where: { $0.0 === pan }) {
      return true
    }
    return otherGestureRecognizer is UIPinchGestureRecognizer
  }

  // MARK: Palm rejection (spec §3)

  private func notePen(_ touch: UITouch) {
    notePen(at: touch.location(in: self), time: touch.timestamp)
  }

  private func notePen(at location: CGPoint, time: TimeInterval, surelyPencil: Bool = true) {
    lastPenTime = time
    lastPenLocation = location
    if surelyPencil && !penReported {
      penReported = true
      onPenSeen([:])  // the first Pencil contact or hover: "pen seen" (the app's auto-picked drawWith)
    }
  }

  private func contactAxisMm(_ touch: UITouch) -> Double {
    // Full major axis (2 × majorRadius), as on Android and web, so the spec's mm thresholds mean the same everywhere.
    return 2 * max(0, Double(touch.majorRadius)) * QalmInkView.mmPerPoint
  }

  private func palmSizeExceeded(_ touch: UITouch) -> Bool {
    return contactAxisMm(touch) > palmThresholdMm
  }

  private func palmReason(_ touch: UITouch) -> String? {
    if palmSizeExceeded(touch) { return "palm-size" }
    let since = touch.timestamp - lastPenTime
    if since < QalmInkView.penLockout { return "pen-lockout" }
    if since < QalmInkView.handSideWindow, let pen = lastPenLocation {
      let loc = touch.location(in: self)
      let margin = CGFloat(QalmInkView.handSideMarginMm / QalmInkView.mmPerPoint)
      let below = loc.y >= pen.y - margin
      let handSide = rightHanded ? loc.x >= pen.x - margin : loc.x <= pen.x + margin
      if below && handSide { return "hand-side" }
    }
    return nil
  }

  private func reject(_ reason: String) {
    onRejectedTouch(["reason": reason])
  }

  private func scheduleFingerClaim(_ recognizer: InkGestureRecognizer) {
    guard let a = active else { return }
    claimCounter += 1
    let token = claimCounter
    a.claimToken = token
    DispatchQueue.main.asyncAfter(deadline: .now() + QalmInkView.fingerClaimDelay) { [weak self, weak recognizer] in
      guard let self = self, let a = self.active, a.claimToken == token else { return }
      recognizer?.claim()
    }
  }

  // MARK: Strokes

  private func begin(_ touch: UITouch, event: UIEvent, isPencil: Bool) {
    let a = Active(touch: touch, isPencil: isPencil, tool: tool, colorString: colorString, color: color,
                   width: strokeWidth, style: penStyle, smoothing: smoothing, location: touch.location(in: self))
    active = a
    cursorLayer.isHidden = true
    configureLiveLayer(a)
    append(a, touch: touch, event: event)
    render(a, predicted: [])
  }

  private func append(_ a: Active, touch: UITouch, event: UIEvent) {
    let samples = event.coalescedTouches(for: touch) ?? [touch]
    for s in samples {
      let pt = makePoint(s, a)
      if let kind = a.snapKind {
        // Adjusting: the stroke stays as drawn; the shape follows the pen.
        a.snapCur = LiveShape.adjust(kind: kind, pts: a.snapBase, from: a.snapFrom, to: SIMD2(pt.x, pt.y))
        continue
      }
      if s.estimatedPropertiesExpectingUpdates.contains(.force), let idx = s.estimationUpdateIndex {
        a.pendingEstimates[idx] = a.points.count
      }
      a.points.append(pt)
      // Holding still: within holdMm of where the hold began (not of the previous point, so a slow drift ends it).
      let mmPerUnit = Double(sx) * QalmInkView.mmPerPoint
      if a.points.count == 1 || hypot(pt.x - a.holdX, pt.y - a.holdY) * mmPerUnit > LiveShape.holdMm {
        a.holdX = pt.x
        a.holdY = pt.y
        a.holdIdx = a.points.count - 1
        a.holdRequest = -1  // an answer to an earlier hold is stale now
        armHold(a)
      }
    }
  }

  // MARK: Live shapes (the hold is timed here; recognition runs in JS: onShapeHold → setShapePreview)

  private func armHold(_ a: Active) {
    holdWork?.cancel()
    holdWork = nil
    guard shapeSnap, a.tool == .pen, a.snapKind == nil else { return }
    let work = DispatchWorkItem { [weak self, weak a] in
      guard let self = self, let a = a else { return }
      self.holdElapsed(a)
    }
    holdWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + LiveShape.holdSeconds, execute: work)
  }

  private func cancelHold() {
    holdWork?.cancel()
    holdWork = nil
  }

  private func holdElapsed(_ a: Active) {
    guard active === a, a.snapKind == nil, a.points.count >= 2 else { return }
    holdCounter += 1
    a.holdRequest = holdCounter
    let pts: [[String: Any]] = a.points[0...a.holdIdx].map { ["x": $0.x, "y": $0.y] }
    onShapeHold(["requestId": holdCounter, "points": pts])
  }

  /// JS answered a hold: snap if the pen is still down and still holding there (otherwise the answer is stale).
  func shapePreview(requestId: Int, kind: String?, pts: [SIMD2<Double>]) {
    guard let a = active, let kind = kind, a.holdRequest == requestId, a.snapKind == nil, let last = a.points.last else { return }
    a.snapKind = kind
    a.snapBase = pts
    a.snapCur = pts
    a.snapFrom = SIMD2(last.x, last.y)
    tick(at: CGPoint(x: CGFloat(last.x) * sx, y: CGFloat(last.y) * sy))
    render(a, predicted: [])
  }

  /// A haptic tick: on the Apple Pencil Pro where the system offers it (iPadOS 17.5+), else the device's own.
  private func tick(at location: CGPoint) {
    if #available(iOS 17.5, *) {
      UICanvasFeedbackGenerator(view: self).alignmentOccurred(at: location)
    } else {
      UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }
  }

  private func shapePath(kind: String, pts: [SIMD2<Double>]) -> CGPath {
    let path = CGMutablePath()
    for pl in LiveShape.polylines(kind: kind, pts: pts) {
      guard let f = pl.first else { continue }
      path.move(to: CGPoint(x: CGFloat(f.x) * sx, y: CGFloat(f.y) * sy))
      for p in pl.dropFirst() { path.addLine(to: CGPoint(x: CGFloat(p.x) * sx, y: CGFloat(p.y) * sy)) }
    }
    return path
  }

  /// Draws a snapped shape on `l` as PageCanvas does: stroked, round caps and joins, the pen's width.
  private func styleShapeLayer(_ l: CAShapeLayer, color: UIColor, width: Double) {
    l.fillColor = nil
    l.strokeColor = color.cgColor
    l.lineWidth = CGFloat(width) * sx
    l.lineCap = .round
    l.lineJoin = .round
    l.opacity = 1
    l.compositingFilter = nil
  }

  /// Float32 rounding: stored points are Float32 (encodePoints), so the overlay computes the outline from
  /// exactly the values PageCanvas will decode.
  @inline(__always) private static func f32(_ v: Double) -> Double { Double(Float(v)) }

  private func makePoint(_ t: UITouch, _ a: Active) -> Pt {
    let loc = t.type == .pencil ? t.preciseLocation(in: self) : t.location(in: self)
    let kx = sx > 0 ? 1 / Double(sx) : 0
    let ky = sy > 0 ? 1 / Double(sy) : 0
    var p = 0.5
    if t.maximumPossibleForce > 0 {
      p = min(1, max(0, Double(t.force / t.maximumPossibleForce)))
    }
    let isPencil = t.type == .pencil
    let tilt = isPencil ? Double(t.altitudeAngle) : Double.pi / 2
    let az = isPencil ? Double(t.azimuthAngle(in: self)) : 0
    let ms = max(0, (t.timestamp - a.start) * 1000)
    return Pt(x: QalmInkView.f32(Double(loc.x) * kx), y: QalmInkView.f32(Double(loc.y) * ky),
              p: QalmInkView.f32(p), tilt: QalmInkView.f32(tilt), az: QalmInkView.f32(az), t: QalmInkView.f32(ms))
  }

  private func configureLiveLayer(_ a: Active) {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    liveLayer.path = nil
    lassoLayer.path = nil
    styleStrokeLayer(liveLayer, tool: a.tool, color: a.color)
    CATransaction.commit()
  }

  private func styleStrokeLayer(_ l: CAShapeLayer, tool: Tool, color: UIColor) {
    l.fillRule = .nonZero
    l.strokeColor = nil
    if tool == .highlighter {
      // A #rrggbbaa highlighter carries its own opacity; #rrggbb uses the default (tech-spec §2).
      let alpha = color.cgColor.alpha
      l.fillColor = color.withAlphaComponent(1).cgColor
      l.opacity = alpha < 1 ? Float(alpha) : FreehandSettings.highlighterAlpha
      l.compositingFilter = QalmInkView.useMultiplyForHighlighter ? "multiplyBlendMode" : nil
    } else {
      l.fillColor = color.cgColor
      l.opacity = 1
      l.compositingFilter = nil
    }
  }

  /// Exactly @qalm/core `strokeOutline`: style and smoothing apply to pens only.
  private func outline(_ points: [Pt], _ a: Active) -> [FHVec] {
    if a.tool == .highlighter {
      let input = points.map { FHInput(x: $0.x, y: $0.y, pressure: FreehandSettings.highlighterPressure) }
      return Freehand.stroke(input, FreehandSettings.highlighter(width: a.width))
    }
    let input = points.map {
      FHInput(x: $0.x, y: $0.y, pressure: FreehandSettings.penPressure(p: $0.p, tilt: $0.tilt, style: a.style))
    }
    return Freehand.stroke(FreehandSettings.stabilize(input, smoothing: a.smoothing),
                           FreehandSettings.pen(width: a.width, style: a.style, smoothing: a.smoothing))
  }

  /// Redraw the in-progress stroke. `predicted` points are drawn this frame only and then discarded.
  private func render(_ a: Active, predicted: [Pt]) {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    defer { CATransaction.commit() }
    if let kind = a.snapKind {
      styleShapeLayer(liveLayer, color: a.color, width: a.width)
      liveLayer.path = shapePath(kind: kind, pts: a.snapCur)
      return
    }
    let pts = predicted.isEmpty ? a.points : a.points + predicted
    switch a.tool {
    case .pen, .highlighter:
      liveLayer.path = pts.isEmpty ? nil : Freehand.path(from: outline(pts, a), sx: sx, sy: sy)
    case .lasso:
      let path = CGMutablePath()
      if lassoRect, let first = pts.first, let last = pts.last {
        path.addRect(CGRect(x: CGFloat(min(first.x, last.x)) * sx, y: CGFloat(min(first.y, last.y)) * sy,
                            width: CGFloat(abs(last.x - first.x)) * sx, height: CGFloat(abs(last.y - first.y)) * sy))
      } else if let first = pts.first {
        path.move(to: CGPoint(x: CGFloat(first.x) * sx, y: CGFloat(first.y) * sy))
        for p in pts.dropFirst() { path.addLine(to: CGPoint(x: CGFloat(p.x) * sx, y: CGFloat(p.y) * sy)) }
        if pts.count > 2 { path.closeSubpath() }
      }
      lassoLayer.path = path
    case .eraser:
      trailLayer.path = eraserPartial ? eraseTrail(pts) : nil
      trailLayer.lineWidth = CGFloat(a.width) * sx
      if let last = pts.last {
        showCursor(at: CGPoint(x: CGFloat(last.x) * sx, y: CGFloat(last.y) * sy), tool: .eraser, width: a.width, color: a.color)
      }
    case .none:
      break
    }
  }

  private func finish(_ a: Active) {
    active = nil
    cancelHold()
    switch a.tool {
    case .pen, .highlighter:
      guard !a.points.isEmpty else { clearLive(); return }
      let outlinePts = outline(a.points, a)  // real points only: exactly what PageCanvas draws
      let points: [[String: Any]] = a.points.map {
        ["x": $0.x, "y": $0.y, "p": $0.p, "tilt": $0.tilt, "az": $0.az, "t": $0.t]
      }
      let held = heldMs(a.points)
      let snapped = a.snapKind.map { (kind: $0, pts: a.snapCur, width: a.width) }
      // Hand the stroke (or the shape it snapped to) to a pending layer that stays until PageCanvas has drawn it.
      if !committed.contains(a.id) {
        let l = CAShapeLayer()
        l.actions = ["path": NSNull(), "position": NSNull(), "bounds": NSNull(), "opacity": NSNull()]
        l.contentsScale = liveLayer.contentsScale
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        l.frame = bounds
        if let s = snapped {
          styleShapeLayer(l, color: a.color, width: s.width)
          l.path = shapePath(kind: s.kind, pts: s.pts)
        } else {
          styleStrokeLayer(l, tool: a.tool, color: a.color)
          l.path = Freehand.path(from: outlinePts, sx: sx, sy: sy)
        }
        strokesLayer.insertSublayer(l, below: liveLayer)
        liveLayer.path = nil
        CATransaction.commit()
        pending[a.id] = Pending(layer: l, outline: outlinePts, shape: snapped)
        let id = a.id
        DispatchQueue.main.asyncAfter(deadline: .now() + QalmInkView.pendingFallback) { [weak self] in
          guard let self = self, let p = self.pending[id] else { return }
          p.layer.removeFromSuperlayer()
          self.pending[id] = nil
        }
      } else {
        clearLive()
      }
      var event: [String: Any] = [
        "id": a.id,
        "tool": a.tool.rawValue,
        "color": a.colorString,
        "width": a.width,
        "points": points,
        "heldMs": held,
        "style": a.style,
        "smoothing": a.smoothing,
      ]
      if let s = snapped {
        event["shape"] = ["kind": s.kind, "pts": s.pts.map { [$0.x, $0.y] }] as [String: Any]
      }
      onStrokeEnd(event)
    case .eraser:
      emitErase(a, isFinal: true)
      cursorLayer.isHidden = true
      trailLayer.path = nil
    case .lasso:
      let polygon: [[String: Any]] = a.points.map { ["x": $0.x, "y": $0.y] }
      CATransaction.begin()
      CATransaction.setDisableActions(true)
      lassoLayer.path = nil
      CATransaction.commit()
      onLasso(["polygon": polygon])
    case .none:
      clearLive()
    }
  }

  /// Drop the stroke in progress without emitting it.
  private func retract(reason: String) {
    guard active != nil else { return }
    cancelHold()
    active = nil
    clearLive()
    cursorLayer.isHidden = true
    reject(reason)
  }

  private func clearLive() {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    liveLayer.path = nil
    lassoLayer.path = nil
    trailLayer.path = nil
    CATransaction.commit()
  }

  /// Partial erase: the eraser's path over its last `eraseTrailMs` (view points).
  private func eraseTrail(_ pts: [Pt]) -> CGPath? {
    guard let now = pts.last?.t else { return nil }
    let trail = pts.filter { $0.t >= now - QalmInkView.eraseTrailMs }
    guard trail.count > 1, let first = trail.first else { return nil }
    let path = CGMutablePath()
    path.move(to: CGPoint(x: CGFloat(first.x) * sx, y: CGFloat(first.y) * sy))
    for p in trail.dropFirst() { path.addLine(to: CGPoint(x: CGFloat(p.x) * sx, y: CGFloat(p.y) * sy)) }
    return path
  }

  private func emitErase(_ a: Active, isFinal: Bool) {
    let n = a.points.count
    if n == 0 { return }
    // The last segment always goes (the app bakes a partial erase on it), even with no new points.
    if n <= a.erasedUpTo && !isFinal { return }
    // Overlap by one point so consecutive segments join.
    let from = max(0, min(a.erasedUpTo, n) - 1)
    let path: [[String: Any]] = a.points[from..<n].map { ["x": $0.x, "y": $0.y] }
    a.erasedUpTo = n
    onErase(isFinal ? ["path": path, "final": true] : ["path": path])
  }

  /// How long the pen stayed within `heldRadius` page units of where it lifted.
  private func heldMs(_ points: [Pt]) -> Double {
    guard let last = points.last else { return 0 }
    var earliest = last.t
    for p in points.reversed() {
      if hypot(p.x - last.x, p.y - last.y) > QalmInkView.heldRadius { break }
      earliest = p.t
    }
    return max(0, last.t - earliest)
  }

  // MARK: Hover preview

  @objc private func handleHover(_ g: UIHoverGestureRecognizer) {
    switch g.state {
    case .began, .changed:
      let loc = g.location(in: self)
      // Before iOS 16.1 a hover may be a trackpad pointer: it still guards the palm, but isn't "pen seen".
      var isPencilHover = true
      var surelyPencil = false
      if #available(iOS 16.1, *) {
        isPencilHover = g.zOffset > 0
        surelyPencil = isPencilHover
      }
      if isPencilHover { notePen(at: loc, time: ProcessInfo.processInfo.systemUptime, surelyPencil: surelyPencil) }
      guard active == nil, tool == .pen || tool == .highlighter || tool == .eraser else {
        if active == nil { cursorLayer.isHidden = true }
        return
      }
      showCursor(at: loc, tool: tool, width: strokeWidth, color: color)
    default:
      if active == nil || active?.tool != .eraser { cursorLayer.isHidden = true }
    }
  }

  private func showCursor(at p: CGPoint, tool: Tool, width: Double, color: UIColor) {
    let d = max(2, CGFloat(width) * sx)
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    cursorLayer.path = CGPath(ellipseIn: CGRect(x: p.x - d / 2, y: p.y - d / 2, width: d, height: d), transform: nil)
    switch tool {
    case .eraser:
      cursorLayer.fillColor = UIColor.white.withAlphaComponent(0.35).cgColor
      cursorLayer.strokeColor = QalmInkView.eraserCursorColor.cgColor
      cursorLayer.lineWidth = 1
    case .highlighter:
      cursorLayer.fillColor = color.withAlphaComponent(0.45).cgColor
      cursorLayer.strokeColor = nil
    default:
      cursorLayer.fillColor = color.withAlphaComponent(0.5).cgColor
      cursorLayer.strokeColor = nil
    }
    cursorLayer.isHidden = false
    CATransaction.commit()
  }

  // MARK: Pencil double-tap / squeeze

  private func emitPenButton(_ kind: String) {
    // While the Pencil writes, a squeeze or double-tap doesn't switch tools (as the barrel button on Android and web).
    if let a = active, a.isPencil { return }
    // Every overlay on screen receives the interaction; fire once.
    let now = ProcessInfo.processInfo.systemUptime
    if now - QalmInkView.lastPenButtonTime < 0.3 { return }
    QalmInkView.lastPenButtonTime = now
    onPenButton(["kind": kind])
  }

  // iPadOS < 17.5
  func pencilInteractionDidTap(_ interaction: UIPencilInteraction) {
    emitPenButton("double-tap")
  }

  @available(iOS 17.5, *)
  func pencilInteraction(_ interaction: UIPencilInteraction, didReceiveTap tap: UIPencilInteraction.Tap) {
    emitPenButton("double-tap")
  }

  @available(iOS 17.5, *)
  func pencilInteraction(_ interaction: UIPencilInteraction, didReceiveSqueeze squeeze: UIPencilInteraction.Squeeze) {
    if squeeze.phase == .ended { emitPenButton("squeeze") }
  }

  // MARK: Helpers

  static func parseColor(_ s: String) -> UIColor? {
    var hex = s.trimmingCharacters(in: .whitespacesAndNewlines)
    guard hex.hasPrefix("#") else { return nil }
    hex.removeFirst()
    if hex.count == 3 || hex.count == 4 { hex = hex.map { "\($0)\($0)" }.joined() }
    guard hex.count == 6 || hex.count == 8, let v = UInt64(hex, radix: 16) else { return nil }
    let r, g, b, a: CGFloat
    if hex.count == 8 {
      r = CGFloat((v >> 24) & 0xff) / 255
      g = CGFloat((v >> 16) & 0xff) / 255
      b = CGFloat((v >> 8) & 0xff) / 255
      a = CGFloat(v & 0xff) / 255
    } else {
      r = CGFloat((v >> 16) & 0xff) / 255
      g = CGFloat((v >> 8) & 0xff) / 255
      b = CGFloat(v & 0xff) / 255
      a = 1
    }
    return UIColor(red: r, green: g, blue: b, alpha: a)
  }
}
