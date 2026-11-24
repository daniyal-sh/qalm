// qalm lecture mode, macOS: transcribes one audio chunk with Apple's on-device recognizer and prints JSON segments
// (docs/lecture-mode.md §4). Electron's main process runs it per chunk: `mac-transcribe <file> [lang]`. The file is
// 16 kHz mono WAV: the renderer decodes MediaRecorder's WebM/Opus first (src/lecture/wav.ts), because AVFoundation,
// which SFSpeechURLRecognitionRequest reads through, has no WebM or Opus-in-WebM support.
//
// Output: [{"t0": ms, "t1": ms, "text": "...", "words": [{"w": "...", "t0": ms, "t1": ms}]}], times relative to the
// chunk. Words are grouped into lines at gaps of 0.8 s or more. On-device recognition is required: the audio never
// leaves the Mac. Exit code 2: no on-device recognizer for the language; 3: not authorized; 1: other errors.
//
// UNBUILT: written on Windows without a Mac. Build on macOS 13+ with ./build.sh (swiftc), then rebuild the desktop
// app; electron-builder bundles build/mac-transcribe when it exists.
import Foundation
import Speech

struct Word: Encodable { let w: String; let t0: Int; let t1: Int }
struct Segment: Encodable { let t0: Int; let t1: Int; let text: String; let words: [Word] }

func fail(_ msg: String, _ code: Int32) -> Never {
  FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
  exit(code)
}

let args = CommandLine.arguments
guard args.count >= 2 else { fail("usage: mac-transcribe <audio file> [lang]", 1) }
let url = URL(fileURLWithPath: args[1])
let lang = args.count >= 3 && !args[2].isEmpty ? args[2] : Locale.current.identifier

// Authorization: the app's Info.plist has NSSpeechRecognitionUsageDescription; the helper inherits the app's grant.
let authSem = DispatchSemaphore(value: 0)
var status = SFSpeechRecognizer.authorizationStatus()
if status == .notDetermined {
  SFSpeechRecognizer.requestAuthorization { s in
    status = s
    authSem.signal()
  }
  authSem.wait()
}
guard status == .authorized else { fail("speech recognition not authorized", 3) }

guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: lang)), recognizer.supportsOnDeviceRecognition else {
  fail("no on-device recognizer for \(lang)", 2)
}

let request = SFSpeechURLRecognitionRequest(url: url)
request.requiresOnDeviceRecognition = true
request.shouldReportPartialResults = false
request.addsPunctuation = true

let done = DispatchSemaphore(value: 0)
var segments: [Segment] = []
var failure: String?

let task = recognizer.recognitionTask(with: request) { result, error in
  if let error = error {
    failure = error.localizedDescription
    done.signal()
    return
  }
  guard let result = result, result.isFinal else { return }
  var words: [Word] = []
  for s in result.bestTranscription.segments {
    words.append(Word(w: s.substring, t0: Int(s.timestamp * 1000), t1: Int((s.timestamp + s.duration) * 1000)))
  }
  // Lines: break at pauses of 0.8 s or more, or after 30 words.
  var line: [Word] = []
  func flush() {
    guard let first = line.first, let last = line.last else { return }
    segments.append(Segment(t0: first.t0, t1: last.t1, text: line.map { $0.w }.joined(separator: " "), words: line))
    line = []
  }
  for w in words {
    if let last = line.last, w.t0 - last.t1 >= 800 || line.count >= 30 { flush() }
    line.append(w)
  }
  flush()
  done.signal()
}

// The recognizer calls back on the main queue: keep the run loop going until it finishes.
while done.wait(timeout: .now() + 0.05) == .timedOut {
  RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.05))
}
_ = task
if let failure = failure {
  // No speech in the chunk is not an error.
  if failure.lowercased().contains("no speech") { print("[]"); exit(0) }
  fail(failure, 1)
}
let data = try JSONEncoder().encode(segments)
print(String(data: data, encoding: .utf8)!)
