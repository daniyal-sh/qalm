import ExpoModulesCore

// Expo module "QalmInk" (tech-spec §3).
// The native view is only a transparent input + live-stroke overlay; PageCanvas (Skia) draws finished content.
public class QalmInkModule: Module {
  public func definition() -> ModuleDefinition {
    Name("QalmInk")

    // QalmInk.renderPdfPage(fileUri, pageIndex, widthPx) -> cached png file uri
    AsyncFunction("renderPdfPage") { (fileUri: String, pageIndex: Int, widthPx: Double, promise: Promise) in
      PdfPageRenderer.render(fileUri: fileUri, pageIndex: pageIndex, widthPx: widthPx) { result in
        switch result {
        case .success(let uri):
          promise.resolve(uri)
        case .failure(let error):
          promise.reject("ERR_QALM_PDF", error.localizedDescription)
        }
      }
    }

    View(QalmInkView.self) {
      Events("onStrokeEnd", "onErase", "onLasso", "onPenButton", "onRejectedTouch", "onShapeHold", "onPenSeen")

      Prop("pageSize") { (view: QalmInkView, size: [String: Any]) in
        let w = InkNum.double(size["w"]) ?? 0
        let h = InkNum.double(size["h"]) ?? 0
        view.setPageSize(w: w, h: h)
      }

      Prop("tool") { (view: QalmInkView, tool: String) in
        view.setTool(tool)
      }

      Prop("color") { (view: QalmInkView, color: String) in
        view.setColor(color)
      }

      Prop("strokeWidth") { (view: QalmInkView, width: Double) in  // not "width": Fabric would read that as layout width
        view.setStrokeWidth(width)
      }

      Prop("penStyle") { (view: QalmInkView, style: String?) in
        view.setPenStyle(style ?? "fountain")
      }

      Prop("smoothing") { (view: QalmInkView, level: Int?) in
        view.setSmoothing(level ?? 0)
      }

      Prop("lassoMode") { (view: QalmInkView, mode: String?) in
        view.setLassoMode(mode ?? "free")
      }

      Prop("eraserMode") { (view: QalmInkView, mode: String?) in
        view.setEraserMode(mode ?? "stroke")
      }

      Prop("input") { (view: QalmInkView, input: [String: Any]) in
        view.setInput(
          drawWith: input["drawWith"] as? String ?? "pen",
          hand: input["hand"] as? String ?? "right",
          palm: input["palm"] as? String ?? "standard"
        )
      }

      Prop("committedIds") { (view: QalmInkView, ids: [String]) in
        view.setCommittedIds(ids)
      }

      // Live shapes on (the app passed `recognizeShape`): the view reports holds with onShapeHold.
      Prop("shapeSnap") { (view: QalmInkView, on: Bool?) in
        view.setShapeSnap(on ?? false)
      }

      // The on-screen ruler in window points ({ cx, cy, angle, length, thickness }) or null.
      Prop("ruler") { (view: QalmInkView, ruler: [String: Any]?) in
        view.setRuler(ruler)
      }

      Prop("laserMode") { (view: QalmInkView, mode: String?) in
        view.setLaserMode(mode ?? "trail")
      }

      // The answer to onShapeHold: { kind, pts: [[x, y], …] } or null (not a shape).
      AsyncFunction("setShapePreview") { (view: QalmInkView, requestId: Int, shape: [String: Any]?) in
        let kind = shape?["kind"] as? String
        let pts: [SIMD2<Double>] = (shape?["pts"] as? [Any] ?? []).compactMap { p in
          guard let xy = p as? [Any], xy.count >= 2, let x = InkNum.double(xy[0]), let y = InkNum.double(xy[1]) else { return nil }
          return SIMD2(x, y)
        }
        view.shapePreview(requestId: requestId, kind: pts.isEmpty ? nil : kind, pts: pts)
      }.runOnQueue(.main)
    }
  }
}

/// Number coercion for values that arrive as `Any` from JS (Double, Int or NSNumber).
enum InkNum {
  static func double(_ v: Any?) -> Double? {
    if let d = v as? Double { return d }
    if let i = v as? Int { return Double(i) }
    if let n = v as? NSNumber { return n.doubleValue }
    if let f = v as? Float { return Double(f) }
    return nil
  }
}
