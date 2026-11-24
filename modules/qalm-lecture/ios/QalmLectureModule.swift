// qalm lecture mode on iPad: on-device transcription of recorded audio chunks (docs/lecture-mode.md §4).
//
// UNBUILT: written on Windows without a Mac or Xcode. Needs a Mac build and an iPad test. The app's Info.plist needs
// NSSpeechRecognitionUsageDescription (app.json → ios.infoPlist) and NSMicrophoneUsageDescription (expo-audio).
import ExpoModulesCore
import Speech

struct WordOut { let w: String; let t0: Int; let t1: Int }

public class QalmLectureModule: Module {
  public func definition() -> ModuleDefinition {
    Name("QalmLecture")

    AsyncFunction("isAvailable") { (lang: String, promise: Promise) in
      QalmLectureModule.authorize { status in
        guard status == .authorized else {
          promise.resolve(["available": false, "why": "Allow speech recognition for qalm in Settings to transcribe lectures on this iPad."])
          return
        }
        guard let r = QalmLectureModule.recognizer(lang) else {
          promise.resolve(["available": false, "why": "There's no speech recognizer for this language on this iPad."])
          return
        }
        if !r.supportsOnDeviceRecognition {
          promise.resolve(["available": false, "why": "This iPad can't recognize speech in this language on the device."])
          return
        }
        promise.resolve(["available": true])
      }
    }

    AsyncFunction("transcribeFile") { (uri: String, lang: String, promise: Promise) in
      guard let url = URL(string: uri), url.isFileURL else {
        promise.reject("E_QALM_LECTURE_URI", "Not a file uri: \(uri)")
        return
      }
      QalmLectureModule.authorize { status in
        guard status == .authorized else {
          promise.reject("E_QALM_LECTURE_AUTH", "Speech recognition is not allowed")
          return
        }
        guard let r = QalmLectureModule.recognizer(lang), r.supportsOnDeviceRecognition else {
          promise.reject("E_QALM_LECTURE_UNAVAILABLE", "No on-device recognizer")
          return
        }
        QalmLectureModule.transcribe(url: url, recognizer: r, promise: promise)
      }
    }
  }

  private static func recognizer(_ lang: String) -> SFSpeechRecognizer? {
    lang.isEmpty ? SFSpeechRecognizer() : SFSpeechRecognizer(locale: Locale(identifier: lang))
  }

  private static func authorize(_ done: @escaping (SFSpeechRecognizerAuthorizationStatus) -> Void) {
    let s = SFSpeechRecognizer.authorizationStatus()
    if s != .notDetermined {
      done(s)
      return
    }
    SFSpeechRecognizer.requestAuthorization { status in DispatchQueue.main.async { done(status) } }
  }

  /// Keeps running tasks alive until they finish.
  private static var tasks: [SFSpeechRecognitionTask] = []

  private static func transcribe(url: URL, recognizer: SFSpeechRecognizer, promise: Promise) {
    let request = SFSpeechURLRecognitionRequest(url: url)
    request.requiresOnDeviceRecognition = true // the audio never leaves the iPad
    request.shouldReportPartialResults = false
    request.addsPunctuation = true
    var settled = false
    var task: SFSpeechRecognitionTask?
    task = recognizer.recognitionTask(with: request) { result, error in
      if settled { return }
      if let error = error {
        settled = true
        tasks.removeAll { $0 === task }
        // A chunk with no speech in it is not an error: no lines.
        let ns = error as NSError
        if ns.domain == "kAFAssistantErrorDomain" && (ns.code == 1110 || ns.code == 203) {
          promise.resolve([[String: Any]]())
        } else {
          promise.reject("E_QALM_LECTURE_FAILED", error.localizedDescription)
        }
        return
      }
      guard let result = result, result.isFinal else { return }
      settled = true
      tasks.removeAll { $0 === task }
      let words = result.bestTranscription.segments.map {
        WordOut(w: $0.substring, t0: Int($0.timestamp * 1000), t1: Int(($0.timestamp + $0.duration) * 1000))
      }
      promise.resolve(lines(words))
    }
    if let task = task { tasks.append(task) }
  }

  /// Words grouped into lines at pauses of 0.8 s or more (or 30 words).
  private static func lines(_ words: [WordOut]) -> [[String: Any]] {
    var out: [[String: Any]] = []
    var line: [WordOut] = []
    func flush() {
      guard let first = line.first, let last = line.last else { return }
      out.append([
        "t0": first.t0,
        "t1": last.t1,
        "text": line.map { $0.w }.joined(separator: " "),
        "words": line.map { ["w": $0.w, "t0": $0.t0, "t1": $0.t1] },
      ])
      line = []
    }
    for w in words {
      if let last = line.last, w.t0 - last.t1 >= 800 || line.count >= 30 { flush() }
      line.append(w)
    }
    flush()
    return out
  }
}
