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

  // MARK: Tunables (spec §3; physical sizes in millimetres)
  private static let mmPerPoint = 0.19               // iPad point ≈ 0.19 mm
  private static let penLockout: TimeInterval = 0.6  // touches within 600 ms of pen activity are rejected
  private static let handSideWindow: TimeInterval = 3.0  // how long the last pen position guards the hand side
  private static let handSideMarginMm = 10.0         // "beside" tolerance around the pen tip
  private static let fingerClaimDelay: TimeInterval = 0.08  // a 2nd finger before this → scroll/zoom, not ink
  private static let fingerClaimDistance: CGFloat = 3       // points of movement that also claim a finger stroke
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
  private var drawWithPen = true
  private var rightHanded = true
  private var palmThresholdMm = 7.0
  private var committed = Set<String>()

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
    let start: TimeInterval
    let startLocation: CGPoint
    var points: [Pt] = []
    var pendingEstimates: [NSNumber: Int] = [:]
    var erasedUpTo = 0  // eraser: points already emitted
    var claimToken = 0
    init(touch: UITouch, isPencil: Bool, tool: Tool, colorString: String, color: UIColor, width: Double, location: CGPoint) {
      self.touch = touch
      self.isPencil = isPencil
      self.tool = tool
      self.colorString = colorString
      self.color = color
      self.width = width
      self.start = touch.timestamp
      self.startLocation = location
    }
  }

  fileprivate struct Pending {
    let layer: CAShapeLayer
    let outline: [FHVec]
  }

  private var active: Active?
  private var pending: [String: Pending] = [:]
  private var lastPenTime: TimeInterval = -1_000_000
  private var lastPenLocation: CGPoint?
  private var claimCounter = 0
  private static var lastPenButtonTime: TimeInterval = -1_000_000  // shared: every overlay on screen gets the pencil interaction

  // MARK: Layers
  private let strokesLayer = CALayer()      // pending (finished) strokes, then the live one on top
  private let liveLayer = CAShapeLayer()
  private let lassoLayer = CAShapeLayer()
  private let cursorLayer = CAShapeLayer()  // hover preview and eraser cursor

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
    for l in [liveLayer, lassoLayer, cursorLayer] {
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

  func setInput(drawWith: String, hand: String, palm: String) {
    drawWithPen = drawWith != "any"
    rightHanded = hand != "left"
    switch palm {
    case "relaxed": palmThresholdMm = 9
    case "strict": palmThresholdMm = 5
    default: palmThresholdMm = 7
    }
    applyInputConfig()
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
    var types: [NSNumber] = [NSNumber(value: UITouch.TouchType.pencil.rawValue)]
    if !drawWithPen { types.append(NSNumber(value: UITouch.TouchType.direct.rawValue)) }
    inkGesture.allowedTouchTypes = types
  }

  // MARK: Layout

  override func layoutSubviews() {
    super.layoutSubviews()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    for l in [strokesLayer, liveLayer, lassoLayer, cursorLayer] {
      l.frame = bounds
    }
    let scale = window?.screen.scale ?? traitCollection.displayScale
    if scale > 0 {
      for l in [strokesLayer, liveLayer, lassoLayer, cursorLayer] { l.contentsScale = scale }
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
      p.layer.path = Freehand.path(from: p.outline, sx: sx, sy: sy)
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

      // Finger (only delivered when drawWith == 'any').
      if let reason = palmReason(touch) {
        reject(reason)
        recognizer.claim()  // swallow the palm so it doesn't scroll the page
        continue
      }
      if let a = active {
        if a.isPencil {
          reject("pen-active")
          continue
        }
        // A second finger: this is a scroll/zoom, not ink.
        retract(reason: "multi-touch")
        recognizer.relinquish()
        return
      }
      begin(touch, event: event, isPencil: false)
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
  }

  // MARK: Gesture delegate

  func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                         shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
    guard gestureRecognizer === inkGesture else { return false }
    if otherGestureRecognizer === hoverGesture { return true }
    // Finger ink keeps the parent's pinch alive, so a second finger can still zoom (we retract then).
    if let a = active, a.isPencil { return false }
    return otherGestureRecognizer is UIPinchGestureRecognizer
  }

  // MARK: Palm rejection (spec §3)

  private func notePen(_ touch: UITouch) {
    lastPenTime = touch.timestamp
    lastPenLocation = touch.location(in: self)
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
                   width: strokeWidth, location: touch.location(in: self))
    active = a
    cursorLayer.isHidden = true
    configureLiveLayer(a)
    append(a, touch: touch, event: event)
    render(a, predicted: [])
  }

  private func append(_ a: Active, touch: UITouch, event: UIEvent) {
    let samples = event.coalescedTouches(for: touch) ?? [touch]
    for s in samples {
      if s.estimatedPropertiesExpectingUpdates.contains(.force), let idx = s.estimationUpdateIndex {
        a.pendingEstimates[idx] = a.points.count
      }
      a.points.append(makePoint(s, a))
    }
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
    l.fillColor = color.cgColor
    if tool == .highlighter {
      l.opacity = FreehandSettings.highlighterAlpha
      l.compositingFilter = QalmInkView.useMultiplyForHighlighter ? "multiplyBlendMode" : nil
    } else {
      l.opacity = 1
      l.compositingFilter = nil
    }
  }

  private func outline(_ points: [Pt], tool: Tool, width: Double) -> [FHVec] {
    if tool == .highlighter {
      let input = points.map { FHInput(x: $0.x, y: $0.y, pressure: FreehandSettings.highlighterPressure) }
      return Freehand.stroke(input, FreehandSettings.highlighter(width: width))
    }
    let input = points.map { FHInput(x: $0.x, y: $0.y, pressure: FreehandSettings.tiltPressure(p: $0.p, tilt: $0.tilt)) }
    return Freehand.stroke(input, FreehandSettings.pen(width: width))
  }

  /// Redraw the in-progress stroke. `predicted` points are drawn this frame only and then discarded.
  private func render(_ a: Active, predicted: [Pt]) {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    defer { CATransaction.commit() }
    let pts = predicted.isEmpty ? a.points : a.points + predicted
    switch a.tool {
    case .pen, .highlighter:
      liveLayer.path = pts.isEmpty ? nil : Freehand.path(from: outline(pts, tool: a.tool, width: a.width), sx: sx, sy: sy)
    case .lasso:
      let path = CGMutablePath()
      if let first = pts.first {
        path.move(to: CGPoint(x: CGFloat(first.x) * sx, y: CGFloat(first.y) * sy))
        for p in pts.dropFirst() { path.addLine(to: CGPoint(x: CGFloat(p.x) * sx, y: CGFloat(p.y) * sy)) }
        if pts.count > 2 { path.closeSubpath() }
      }
      lassoLayer.path = path
    case .eraser:
      if let last = pts.last {
        showCursor(at: CGPoint(x: CGFloat(last.x) * sx, y: CGFloat(last.y) * sy), tool: .eraser, width: a.width, color: a.color)
      }
    case .none:
      break
    }
  }

  private func finish(_ a: Active) {
    active = nil
    switch a.tool {
    case .pen, .highlighter:
      guard !a.points.isEmpty else { clearLive(); return }
      let outlinePts = outline(a.points, tool: a.tool, width: a.width)
      let points: [[String: Any]] = a.points.map {
        ["x": $0.x, "y": $0.y, "p": $0.p, "tilt": $0.tilt, "az": $0.az, "t": $0.t]
      }
      let held = heldMs(a.points)
      // Hand the stroke to a pending layer that stays until PageCanvas has drawn it.
      if !committed.contains(a.id) {
        let l = CAShapeLayer()
        l.actions = ["path": NSNull(), "position": NSNull(), "bounds": NSNull(), "opacity": NSNull()]
        l.contentsScale = liveLayer.contentsScale
        styleStrokeLayer(l, tool: a.tool, color: a.color)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        l.frame = bounds
        l.path = Freehand.path(from: outlinePts, sx: sx, sy: sy)
        strokesLayer.insertSublayer(l, below: liveLayer)
        liveLayer.path = nil
        CATransaction.commit()
        pending[a.id] = Pending(layer: l, outline: outlinePts)
        let id = a.id
        DispatchQueue.main.asyncAfter(deadline: .now() + QalmInkView.pendingFallback) { [weak self] in
          guard let self = self, let p = self.pending[id] else { return }
          p.layer.removeFromSuperlayer()
          self.pending[id] = nil
        }
      } else {
        clearLive()
      }
      onStrokeEnd([
        "id": a.id,
        "tool": a.tool.rawValue,
        "color": a.colorString,
        "width": a.width,
        "points": points,
        "heldMs": held,
      ])
    case .eraser:
      emitErase(a, isFinal: true)
      cursorLayer.isHidden = true
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
    CATransaction.commit()
  }

  private func emitErase(_ a: Active, isFinal: Bool) {
    let n = a.points.count
    if n == 0 { return }
    if n <= a.erasedUpTo { return }
    // Overlap by one point so consecutive segments join.
    let from = max(0, a.erasedUpTo - 1)
    let path: [[String: Any]] = a.points[from..<n].map { ["x": $0.x, "y": $0.y] }
    a.erasedUpTo = n
    onErase(["path": path])
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
      var isPencilHover = true
      if #available(iOS 16.1, *) { isPencilHover = g.zOffset > 0 }
      if isPencilHover {
        lastPenTime = ProcessInfo.processInfo.systemUptime
        lastPenLocation = loc
      }
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
