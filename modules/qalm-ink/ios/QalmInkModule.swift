import ExpoModulesCore

// Expo module "QalmInk" (tech-spec §3).
// The native view is only a transparent input + live-stroke overlay; PageCanvas (Skia) draws finished content.
public class QalmInkModule: Module {
  public func definition() -> ModuleDefinition {
    Name("QalmInk")

    // QalmInk.recognize(lines, lang) -> [{ key, text, score }]
    AsyncFunction("recognize") { (lines: [[String: Any]], lang: String, promise: Promise) in
      let parsed = InkRecognizer.parseLines(lines)
      InkRecognizer.shared.recognize(lines: parsed, lang: lang) { result in
        switch result {
        case .success(let rows):
          promise.resolve(rows)
        case .failure(let error):
          promise.reject("ERR_QALM_RECOGNIZE", error.localizedDescription)
        }
      }
    }

    // QalmInk.ensureModel(lang) -> void (downloads the ML Kit model if needed)
    AsyncFunction("ensureModel") { (lang: String, promise: Promise) in
      InkRecognizer.shared.ensureModel(lang: lang) { error in
        if let error = error {
          promise.reject("ERR_QALM_MODEL", error.localizedDescription)
        } else {
          promise.resolve()
        }
      }
    }

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
      Events("onStrokeEnd", "onErase", "onLasso", "onPenButton", "onRejectedTouch")

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

      Prop("width") { (view: QalmInkView, width: Double) in
        view.setStrokeWidth(width)
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
