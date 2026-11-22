import UIKit
import UIKit.UIGestureRecognizerSubclass

/// Feeds raw touches to `QalmInkView` and decides when the overlay "claims" a touch sequence.
///
/// Claiming (state = .began) makes UIKit fail ancestor gestures that would conflict (the page list's
/// scroll pan, RNGH pinch), so a stroke never scrolls the page. Touches the recognizer is not allowed
/// to see (fingers when drawWith == 'pen', via `allowedTouchTypes`) never reach it, so they keep
/// scrolling and zooming the parent.
final class InkGestureRecognizer: UIGestureRecognizer {
  weak var inkView: QalmInkView?
  private(set) var tracked = Set<UITouch>()

  // Configured by QalmInkView: cancelsTouchesInView, delaysTouchesBegan and delaysTouchesEnded are all false.

  /// Start owning the current touch sequence. No-op if already claimed or finished.
  func claim() {
    if state == .possible { state = .began }
  }

  /// Give the sequence up (e.g. two fingers landed: let the parent scroll/zoom).
  func relinquish() {
    switch state {
    case .possible: state = .failed
    case .began, .changed: state = .cancelled
    default: break
    }
  }

  // Ancestor gestures that already started (a scroll in flight) must not stop a pencil stroke.
  override func canBePrevented(by preventingGestureRecognizer: UIGestureRecognizer) -> Bool {
    return false
  }

  override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
    tracked.formUnion(touches)
    inkView?.inkTouchesBegan(touches, event: event, recognizer: self)
  }

  override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
    inkView?.inkTouchesMoved(touches, event: event, recognizer: self)
    if state == .began || state == .changed { state = .changed }
  }

  override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
    tracked.subtract(touches)
    inkView?.inkTouchesEnded(touches, event: event, recognizer: self)
    finishIfIdle(cancelled: false)
  }

  override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
    tracked.subtract(touches)
    inkView?.inkTouchesCancelled(touches, event: event, recognizer: self)
    finishIfIdle(cancelled: true)
  }

  override func touchesEstimatedPropertiesUpdated(_ touches: Set<UITouch>) {
    inkView?.inkEstimatedPropertiesUpdated(touches)
  }

  override func reset() {
    super.reset()
    tracked.removeAll()
    inkView?.inkRecognizerDidReset()
  }

  private func finishIfIdle(cancelled: Bool) {
    guard tracked.isEmpty else { return }
    switch state {
    case .possible: state = .failed
    case .began, .changed: state = cancelled ? .cancelled : .ended
    default: break
    }
  }
}
