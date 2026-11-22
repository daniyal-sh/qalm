# qalm-ink: iOS (iPadOS 17+)

This is the Swift side of the `QalmInk` Expo module (tech-spec §3). The native view (`QalmInkView`) is only a transparent input
and live-stroke overlay. `PageCanvas` (Skia) draws all finished content.

These files were written on Windows without Xcode and **have not been compiled yet**. Work through the checklist below on a Mac.

## Files
| File | What it does |
|---|---|
| `QalmInkModule.swift` | `Module` definition: `Name("QalmInk")`, the view's props and events, and `recognize`, `ensureModel` and `renderPdfPage` |
| `QalmInkView.swift` | `ExpoView` overlay with palm rejection, the live stroke, pending strokes until `committedIds`, eraser, lasso, hover preview and the Pencil double-tap and squeeze |
| `InkGestureRecognizer.swift` | Touch pipe. It "claims" a touch sequence so ink never scrolls the page. Fingers in `drawWith: 'pen'` never reach it |
| `Freehand.swift` | Port of perfect-freehand (MIT) `getStrokePoints` and `getStrokeOutlinePoints`, the spec §2 settings, and the outline-to-path step |
| `InkRecognizer.swift` | ML Kit Digital Ink: on-demand model download and the best candidate per line key. If ML Kit isn't linked it compiles to a stub that resolves `[]` |
| `PdfPageRenderer.swift` | PDFKit renders the page to PNG in `Caches/qalm-pdf/`, keyed by file (plus size and mtime), page and width |

## Podspec lines (`QalmInk.podspec`)
```ruby
s.platforms        = { :ios => '17.0' }
s.swift_version    = '5.9'
s.static_framework = true                      # needed for ML Kit's static frameworks
s.source_files     = "ios/**/*.{h,m,swift}"
s.dependency 'ExpoModulesCore'
s.dependency 'GoogleMLKit/DigitalInkRecognition', '>= 7.0.0'   # pin to the version pod install resolves
s.frameworks       = 'UIKit', 'QuartzCore', 'PDFKit'
```
If `s.platforms` stays below 16.1, the code still compiles because `zOffset` and the 17.5 Pencil APIs are behind `#available`.

## Behaviour notes (the choices I made where the spec leaves room)
- **Coordinates:** points are in page units: `x × pageSize.w / bounds.width`, and the same for y. Every value is rounded to Float32, so
  the overlay builds its outline from exactly the numbers that `encodePoints` stores and `PageCanvas` decodes.
- **Point fields:** `p` is `force / maximumPossibleForce`, or 0.5 for fingers (iPad fingers report no force). `tilt` is `altitudeAngle`, `az` is `azimuthAngle(in:)`, and `t` is in ms since
  the stroke started. Pencil force estimates are patched when `touchesEstimatedPropertiesUpdated` arrives.
- **Live stroke:** each touch batch appends the coalesced touches, adds `predictedTouches` for that frame only, and rebuilds the
  perfect-freehand outline (`last: true`, as in the spec) into a `CAShapeLayer`, with no implicit animations.
- **Outline to path:** this uses the same construction as perfect-freehand's `getSvgPathFromStroke` (`M p0 Q p1 mid(p1,p2) T …
  Z`), filled with non-zero winding. **`@qalm/core`'s `strokeSvgPath`/PageCanvas must build the path the same way**, or hand-off will be off by a few sub-pixels.
- **Hand-off:** when the pen lifts, the stroke moves to a pending layer that stays until its id is in `committedIds`. There's a
  fallback: it's removed after 4 s anyway, for strokes the app turns into something else, such as snapped shapes. Ids are lowercase UUIDs.
- **Highlighter:** drawn at 0.45 opacity with `compositingFilter = "multiplyBlendMode"`. Set `useMultiplyForHighlighter = false`
  if that renders wrongly on device.
- **Eraser:** `onErase` fires on every move with the new segment, overlapping the previous one by one point, and once more on lift if there are new
  points. A grey circle of `width` shows where the eraser is.
- **Lasso:** a dashed indigo (`accent`) closed polygon while dragging. `onLasso` fires on lift, then the polygon clears.
- **`heldMs`:** the time between the earliest of the trailing points within 2 page units of the lift point and the lift itself.
- **Palm rejection, in mm with 1 pt ≈ 0.19 mm:**
  1. Pencil always draws. With `drawWith: 'pen'`, the recognizer's `allowedTouchTypes` is pencil only, so fingers pass straight through
     to the page list's scroll and the RNGH pinch.
  2. Contact axis = `2 × (majorRadius − majorRadiusTolerance) × 0.19` mm, compared against 9, 7 or 5 mm. I used the lower bound because iOS
     quantizes `majorRadius` (a fingertip is about 20.8 pt, which is 7.9 mm without the tolerance, so a normal finger would fail "standard"). **Tune on device.**
     This is checked on every move too, so a finger stroke that grows into a palm is retracted.
  3. A finger is rejected within 600 ms of pencil activity, which includes Pencil hover where `zOffset > 0`. It's also rejected if it lands below or
     beside (±10 mm) the last pen position on the `hand` side, but only within 3 s of the last pen activity.
     A palm that's rejected is still claimed, so it doesn't scroll the page.
  4. `touchesCancelled` (or the recognizer resetting mid-stroke) retracts the stroke without emitting. `onRejectedTouch` reasons are `palm-size`,
     `pen-lockout`, `hand-side`, `pen-active`, `pen-took-over`, `multi-touch` and `cancelled`.
- **`drawWith: 'any'`:** a finger stroke draws at once but only claims the touches after 3 pt of movement or 80 ms. If a second finger lands before
  that, the stroke is retracted and the scroll or zoom proceeds. After that, the RNGH pinch can still start alongside a finger stroke; the stroke is then retracted and the
  pinch wins. Two-finger *scroll* only works if both fingers land within that 80 ms window.
- **Pen button:** `UIPencilInteraction` sends `double-tap` (`pencilInteractionDidTap` before 17.5, `didReceiveTap` from 17.5 on) and `squeeze`
  (17.5+, on `.ended`). Every overlay on screen receives the interaction, so a shared 300 ms debounce makes it fire only once.
- **`recognize`:** runs lines one at a time with the en-US model, downloading it first if needed. Stroke times are offset so they keep increasing across
  strokes. `score` is ML Kit's candidate score, a cost where lower is better, or 0 when the model gives none. Lines with no candidate are left out.
- **`renderPdfPage`:** the PNG is opaque, on white, exactly `widthPx` wide, uses the media box, applies page rotation (through `PDFPage.thumbnail`), and is returned
  as a `file://` URI. It renders on a background queue.

## Checklist on a Mac with an iPad and Apple Pencil
**Build**
- [ ] `pod install` resolves `GoogleMLKit/DigitalInkRecognition`. Pin its version in the podspec.
- [ ] The module compiles. The APIs I'm least sure about are listed under "Compile risks" below.
- [ ] Simulator builds: ML Kit may need `EXCLUDED_ARCHS[sdk=iphonesimulator*] = arm64` on older ML Kit releases. Use a device for ink anyway.

**Ink**
- [ ] Strokes appear under the Pencil with no visible lag. Fast scribbles show the predicted tail, with no leftover "ghost" tail after lifting.
- [ ] Hand-off is clean: no flicker, pop or shift when PageCanvas takes over. Compare a pen stroke and a highlighter stroke at 1×, 2× and 4× zoom.
      If the edge shifts slightly, compare the path construction with `strokeSvgPath`.
- [ ] Tilt shading: the stroke gets thicker as the Pencil tilts. Pressure changes the width, and the first point isn't blobby.
- [ ] The highlighter multiplies over ink, so black ink stays black under yellow, and it doesn't turn black or invisible.
- [ ] Pending strokes disappear when committed, and also after 4 s if the app never commits them (for example a snapped shape).
- [ ] Rotating the iPad or changing the layout width (zoom end) keeps the live and pending strokes aligned with the page.

**Input and palm rejection**
- [ ] `drawWith: 'pen'`: one finger scrolls the page list and two fingers pinch-zoom while the pen tool is active. The Pencil never scrolls,
      even with a palm resting first.
- [ ] `drawWith: 'any'`: one finger draws, two fingers landing together scroll or zoom, and a late second finger retracts the stroke and zooms.
- [ ] Resting a palm (on the `hand` side) before or while writing never draws, scrolls or leaves marks. Try relaxed, standard and strict with
      fingers, flat fingers and palms, and adjust the `majorRadiusTolerance` handling if needed.
- [ ] `hand: 'left'` mirrors the hand-side rule.
- [ ] Pulling down Control Center or Notification Center mid-stroke retracts the stroke (`touchesCancelled`).
- [ ] `tool: 'none'` lets the Pencil scroll too, and draws nothing.

**Pencil extras**
- [ ] Hover (M2 or later iPad with Pencil 2 or Pro) shows a circle the size of the brush, and hides when the Pencil touches down or moves away.
- [ ] Double-tap fires `onPenButton {kind:'double-tap'}` once, even with several pages on screen. Squeeze (Pencil Pro, iPadOS 17.5+) fires
      `squeeze` once.

**Eraser, lasso, `heldMs`**
- [ ] The eraser sends `onErase` while moving, and the cursor circle follows it. The lasso draws a dashed polygon and sends `onLasso` on lift.
- [ ] Holding the Pencil still for at least 500 ms at the end of a stroke reports `heldMs` ≥ 500, which triggers shape snapping.

**Functions**
- [ ] `ensureModel('en-US')` downloads once (watch for the network call), and later calls resolve at once.
- [ ] `recognize` returns sensible text for handwritten lines, with one entry per key.
- [ ] `renderPdfPage` returns a PNG that is exactly `widthPx` wide, for portrait, landscape and rotated pages. A second call hits the cache.

## Compile risks (check these first)
- The `ExpoView` subclass has `required init(appContext:)` and no `init(coder:)`, as in Expo's own template.
- Props typed `[String: Any]` (`pageSize`, `input`), and `[[String: Any]]` for the `recognize` argument.
- `promise.resolve()` with no argument, and `promise.reject(code, message)`.
- ML Kit Swift names: `DigitalInkRecognitionModelIdentifier(forLanguageTag:)`, `ModelManager.modelManager()`,
  `ModelDownloadConditions(allowsCellularAccess:allowsBackgroundDownloading:)`, `.mlkitModelDownloadDidSucceed/Fail`,
  `ModelDownloadUserInfoKey`, `StrokePoint(x:y:t:)`, `candidate.score` as `NSNumber?`. Also whether the module is `MLKitDigitalInkRecognition` and `MLKitCommon`, or the
  `MLKit` umbrella. If ML Kit can't be imported, the stub is compiled silently, so **check that `recognize` returns results**.
- `UIPencilInteraction.Tap` / `.Squeeze` and `squeeze.phase == .ended` (iOS 17.5 SDK, Xcode 15.4+).
- `CAShapeLayer.compositingFilter = "multiplyBlendMode"`.
- `UIGestureRecognizer` subclass state changes (`import UIKit.UIGestureRecognizerSubclass`), and `touchesEstimatedPropertiesUpdated`.
