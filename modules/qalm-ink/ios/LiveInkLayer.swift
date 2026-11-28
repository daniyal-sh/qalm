import QuartzCore
import CoreGraphics

/// The pen or highlighter stroke in progress (tech-spec §3). A `CAShapeLayer` re-rasterises its whole path on the
/// CPU whenever the path changes, so long strokes got slower every frame. This layer keeps its backing store and
/// each `show` invalidates only the box where the outline changed (`InkDamage.changedBounds`), so Core Graphics
/// fills only that box (the context is clipped to it). Opacity and the highlighter's multiply compositing are set
/// on the layer itself, as on the stroke layers.
final class LiveInkLayer: CALayer {
  /// The outline drawn (page units), the points per page unit it was drawn at, and its fill.
  private var outline: [FHVec] = []
  private var scaleX: CGFloat = 0
  private var scaleY: CGFloat = 0
  private var fill: CGColor?
  /// Points of padding around a changed box, for antialiasing.
  private static let pad: CGFloat = 2

  /// A new stroke (or none): start empty and redraw everything.
  func reset(fill: CGColor?) {
    outline = []
    self.fill = fill
    setNeedsDisplay()
  }

  /// Draw `next` (page units) at `sx`/`sy` points per unit, redrawing only where it differs from what is shown.
  func show(_ next: [FHVec], sx: CGFloat, sy: CGFloat) {
    if sx != scaleX || sy != scaleY {
      // A layout or page-size change: everything moves.
      outline = next
      scaleX = sx
      scaleY = sy
      setNeedsDisplay()
      return
    }
    let box = InkDamage.changedBounds(outline, next)
    outline = next
    guard let b = box else { return }
    let p = LiveInkLayer.pad
    setNeedsDisplay(CGRect(x: CGFloat(b[0]) * sx - p, y: CGFloat(b[1]) * sy - p,
                           width: CGFloat(b[2] - b[0]) * sx + 2 * p, height: CGFloat(b[3] - b[1]) * sy + 2 * p))
  }

  /// Called with the context clipped to the invalidated area; the rest of the backing store is kept.
  override func draw(in ctx: CGContext) {
    ctx.clear(ctx.boundingBoxOfClipPath)
    guard let fill = fill, outline.count >= 4 else { return }
    ctx.addPath(Freehand.path(from: outline, sx: scaleX, sy: scaleY))
    ctx.setFillColor(fill)
    ctx.fillPath(using: .winding)
  }
}
