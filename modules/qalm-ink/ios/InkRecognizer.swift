import Foundation

#if canImport(MLKitDigitalInkRecognition)
import MLKitDigitalInkRecognition
#endif
#if canImport(MLKitCommon)
import MLKitCommon
#endif

/// One line to recognize: strokes of page-unit points with `t` in ms since each stroke's start.
struct RecognizeLine {
  struct Point { let x: Double; let y: Double; let t: Double }
  let key: String
  let strokes: [[Point]]
}

struct InkRecognizerError: LocalizedError {
  let message: String
  var errorDescription: String? { message }
}

/// On-device handwriting recognition with Google ML Kit Digital Ink (tech-spec §3).
/// The model is downloaded on demand. All state is touched on the main queue.
final class InkRecognizer {
  static let shared = InkRecognizer()

  static func parseLines(_ raw: [[String: Any]]) -> [RecognizeLine] {
    var out: [RecognizeLine] = []
    for line in raw {
      guard let key = line["key"] as? String else { continue }
      var strokes: [[RecognizeLine.Point]] = []
      let rawStrokes = line["strokes"] as? [Any] ?? []
      for rs in rawStrokes {
        guard let rawPoints = rs as? [Any] else { continue }
        var pts: [RecognizeLine.Point] = []
        pts.reserveCapacity(rawPoints.count)
        for rp in rawPoints {
          guard let d = rp as? [String: Any],
                let x = InkNum.double(d["x"]),
                let y = InkNum.double(d["y"]) else { continue }
          pts.append(RecognizeLine.Point(x: x, y: y, t: InkNum.double(d["t"]) ?? 0))
        }
        if !pts.isEmpty { strokes.append(pts) }
      }
      out.append(RecognizeLine(key: key, strokes: strokes))
    }
    return out
  }

#if canImport(MLKitDigitalInkRecognition)

  private var models: [String: DigitalInkRecognitionModel] = [:]
  private var recognizers: [String: DigitalInkRecognizer] = [:]
  private var waiters: [String: [(Error?) -> Void]] = [:]
  private var observers: [NSObjectProtocol] = []

  private init() {
    let center = NotificationCenter.default
    observers.append(center.addObserver(forName: .mlkitModelDownloadDidSucceed, object: nil, queue: .main) { [weak self] note in
      self?.handleDownload(note, error: nil)
    })
    observers.append(center.addObserver(forName: .mlkitModelDownloadDidFail, object: nil, queue: .main) { [weak self] note in
      let err = note.userInfo?[ModelDownloadUserInfoKey.error.rawValue] as? Error
      self?.handleDownload(note, error: err ?? InkRecognizerError(message: "Model download failed"))
    })
  }

  private func model(for lang: String) -> DigitalInkRecognitionModel? {
    if let m = models[lang] { return m }
    guard let identifier = DigitalInkRecognitionModelIdentifier(forLanguageTag: lang) else { return nil }
    let m = DigitalInkRecognitionModel(modelIdentifier: identifier)
    models[lang] = m
    return m
  }

  private func handleDownload(_ note: Notification, error: Error?) {
    guard let downloaded = note.userInfo?[ModelDownloadUserInfoKey.remoteModel.rawValue] as? DigitalInkRecognitionModel else { return }
    for (lang, m) in models where m == downloaded {
      let list = waiters.removeValue(forKey: lang) ?? []
      list.forEach { $0(error) }
    }
  }

  func ensureModel(lang: String, completion: @escaping (Error?) -> Void) {
    DispatchQueue.main.async {
      guard let m = self.model(for: lang) else {
        completion(InkRecognizerError(message: "Unsupported language \(lang)"))
        return
      }
      let manager = ModelManager.modelManager()
      if manager.isModelDownloaded(m) {
        completion(nil)
        return
      }
      let first = self.waiters[lang] == nil
      self.waiters[lang, default: []].append(completion)
      if first {
        let conditions = ModelDownloadConditions(allowsCellularAccess: true, allowsBackgroundDownloading: true)
        _ = manager.download(m, conditions: conditions)
      }
    }
  }

  private func recognizer(for lang: String) -> DigitalInkRecognizer? {
    if let r = recognizers[lang] { return r }
    guard let m = model(for: lang) else { return nil }
    let options = DigitalInkRecognizerOptions(model: m)
    let r = DigitalInkRecognizer.digitalInkRecognizer(options: options)
    recognizers[lang] = r
    return r
  }

  func recognize(lines: [RecognizeLine], lang: String, completion: @escaping (Result<[[String: Any]], Error>) -> Void) {
    ensureModel(lang: lang) { error in
      // ensureModel calls back on the main queue.
      if let error = error {
        completion(.failure(error))
        return
      }
      guard let recognizer = self.recognizer(for: lang) else {
        completion(.failure(InkRecognizerError(message: "No recognizer for \(lang)")))
        return
      }
      var results: [[String: Any]] = []
      // One line at a time, in order.
      func next(_ index: Int) {
        if index >= lines.count {
          completion(.success(results))
          return
        }
        let line = lines[index]
        guard let ink = InkRecognizer.makeInk(line) else {
          next(index + 1)
          return
        }
        recognizer.recognize(ink: ink) { result, _ in
          DispatchQueue.main.async {
            if let best = result?.candidates.first {
              // ML Kit's score is a cost (lower is better) and is only present for some models.
              results.append(["key": line.key, "text": best.text, "score": best.score?.doubleValue ?? 0])
            }
            next(index + 1)
          }
        }
      }
      next(0)
    }
  }

  private static func makeInk(_ line: RecognizeLine) -> Ink? {
    var strokes: [Stroke] = []
    var offset = 0.0  // keep time increasing across strokes
    for s in line.strokes {
      var pts: [StrokePoint] = []
      pts.reserveCapacity(s.count)
      var lastT = offset
      for p in s {
        let t = offset + max(0, p.t)
        lastT = max(lastT, t)
        pts.append(StrokePoint(x: Float(p.x), y: Float(p.y), t: Int(t.rounded())))
      }
      offset = lastT + 1
      if !pts.isEmpty { strokes.append(Stroke(points: pts)) }
    }
    return strokes.isEmpty ? nil : Ink(strokes: strokes)
  }

#else

  // ML Kit is not linked: recognition resolves [] (same as desktop).
  private init() {}

  func ensureModel(lang: String, completion: @escaping (Error?) -> Void) {
    completion(nil)
  }

  func recognize(lines: [RecognizeLine], lang: String, completion: @escaping (Result<[[String: Any]], Error>) -> Void) {
    completion(.success([]))
  }

#endif
}
