import UIKit

/// The ruler (tech-spec §7, Ruler): a port of @qalm/core `rulerEdges` / `rulerEdgeAt` / `projectOnLine` (and of
/// Android's RulerSnap.kt). The pose is in window points (React Native's measureInWindow): centre, angle (radians,
/// clockwise), length and thickness. A pen or highlighter stroke that starts within `snapPoints` outside a long edge
/// (or over the ruler's half next to it) is drawn along that edge, every point projected onto the edge line pushed
/// out by half the pen width. NOTE: never compiled (no Mac yet); keep in step with RulerSnap.kt.
enum RulerSnap {
  /// InkOverlay.types RULER_SNAP_PX (core RULER.snapPx).
  static let snapPoints = 24.0

  struct Pose {
    var cx: Double, cy: Double, angle: Double, length: Double, thickness: Double
  }

  /// One long edge from a to b, with n its outward unit normal.
  struct Edge {
    var a: SIMD2<Double>, b: SIMD2<Double>, n: SIMD2<Double>
  }

  /// The two long edges: the "top" one (at angle 0, the upper edge) first.
  static func edges(_ r: Pose) -> (Edge, Edge) {
    let u = SIMD2(cos(r.angle), sin(r.angle))
    let n = SIMD2(sin(r.angle), -cos(r.angle))
    let hl = r.length / 2, ht = r.thickness / 2
    func edge(_ s: Double) -> Edge {
      let o = SIMD2(r.cx, r.cy) + n * (ht * s)
      return Edge(a: o - u * hl, b: o + u * hl, n: n * s)
    }
    return (edge(1), edge(-1))
  }

  /// The edge a stroke starting at `p` snaps to, or nil.
  static func edgeAt(_ r: Pose, _ p: SIMD2<Double>, zone: Double = snapPoints) -> Edge? {
    let u = SIMD2(cos(r.angle), sin(r.angle))
    let d = p - SIMD2(r.cx, r.cy)
    if abs(d.x * u.x + d.y * u.y) > r.length / 2 + zone { return nil }
    let (e0, e1) = edges(r)
    let across = d.x * e0.n.x + d.y * e0.n.y
    let ht = r.thickness / 2
    if across >= 0 && across <= ht + zone { return e0 }
    if across < 0 && -across <= ht + zone { return e1 }
    return nil
  }

  /// `p` projected onto the infinite line through a and b.
  static func project(_ p: SIMD2<Double>, _ a: SIMD2<Double>, _ b: SIMD2<Double>) -> SIMD2<Double> {
    let d = b - a
    let len2 = d.x * d.x + d.y * d.y
    if len2 == 0 { return a }
    let t = ((p.x - a.x) * d.x + (p.y - a.y) * d.y) / len2
    return a + d * t
  }

  /// The line a stroke follows in page units: the edge mapped by `toPage` (window points → page units), pushed out
  /// by `offset` page units.
  static func line(_ e: Edge, toPage: (SIMD2<Double>) -> SIMD2<Double>, offset: Double) -> (SIMD2<Double>, SIMD2<Double>) {
    let a = toPage(e.a), b = toPage(e.b)
    var n = toPage(e.a + e.n) - a
    let l = (n.x * n.x + n.y * n.y).squareRoot()
    n = l > 0 ? n / l : SIMD2(0, 0)
    return (a + n * offset, b + n * offset)
  }
}

/// The laser pointer (InkOverlay.types LASER_*): a glowing trail that fades over `fadeSeconds`, or a dot. Drawn by
/// this view over the overlay's layers; it takes no touches and nothing it shows is ever saved.
final class LaserView: UIView {
  static let fadeSeconds: TimeInterval = 1.0  // LASER_FADE_MS
  static let core = UIColor(red: 0xb9 / 255.0, green: 0x1c / 255.0, blue: 0x1c / 255.0, alpha: 1)  // brand bad
  static let glow = UIColor(red: 0xf8 / 255.0, green: 0x71 / 255.0, blue: 0x71 / 255.0, alpha: 1)  // dark-theme bad

  struct Pt {
    var p: CGPoint  // view points
    var t: TimeInterval  // system uptime
    var start: Bool
  }

  private(set) var trail: [Pt] = []
  /// The dot ("dot" mode), view points; nil hides it.
  var dot: CGPoint? { didSet { if dot != oldValue { setNeedsDisplay() } } }
  private var link: CADisplayLink?

  override init(frame: CGRect) {
    super.init(frame: frame)
    isOpaque = false
    backgroundColor = .clear
    isUserInteractionEnabled = false
    contentMode = .redraw
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

  func add(_ p: CGPoint, start: Bool) {
    trail.append(Pt(p: p, t: ProcessInfo.processInfo.systemUptime, start: start))
    run()
  }

  func clear() {
    trail.removeAll()
    dot = nil
    link?.invalidate()
    link = nil
    setNeedsDisplay()
  }

  /// Keeps redrawing (fading) until the trail is gone.
  private func run() {
    setNeedsDisplay()
    if link != nil { return }
    let l = CADisplayLink(target: self, selector: #selector(frameTick))
    l.add(to: .main, forMode: .common)
    link = l
  }

  @objc private func frameTick() {
    let now = ProcessInfo.processInfo.systemUptime
    trail.removeAll { now - $0.t >= LaserView.fadeSeconds }
    setNeedsDisplay()
    if trail.isEmpty {
      link?.invalidate()
      link = nil
    }
  }

  override func draw(_ rect: CGRect) {
    guard let ctx = UIGraphicsGetCurrentContext() else { return }
    ctx.setLineCap(.round)
    ctx.setLineJoin(.round)
    let now = ProcessInfo.processInfo.systemUptime
    for pass in 0..<2 {
      let colour = pass == 0 ? LaserView.glow : LaserView.core
      ctx.setLineWidth(pass == 0 ? 10 : 3)
      for j in trail.indices.dropFirst() where !trail[j].start {
        let k = max(0, min(1, 1 - (now - trail[j].t) / LaserView.fadeSeconds))
        ctx.setStrokeColor(colour.withAlphaComponent(CGFloat(k) * (pass == 0 ? 0.35 : 1)).cgColor)
        ctx.move(to: trail[j - 1].p)
        ctx.addLine(to: trail[j].p)
        ctx.strokePath()
      }
    }
    if let d = dot {
      ctx.setFillColor(LaserView.glow.withAlphaComponent(0.35).cgColor)
      ctx.fillEllipse(in: CGRect(x: d.x - 9, y: d.y - 9, width: 18, height: 18))
      ctx.setFillColor(LaserView.core.cgColor)
      ctx.fillEllipse(in: CGRect(x: d.x - 4, y: d.y - 4, width: 8, height: 8))
    }
  }

  override func removeFromSuperview() {
    link?.invalidate()
    link = nil
    super.removeFromSuperview()
  }
}
