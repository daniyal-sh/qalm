import Foundation
import PDFKit
import UIKit

/// QalmInk.renderPdfPage: renders one PDF page (media box, page rotation applied) to an opaque PNG that is
/// `widthPx` pixels wide, cached in Caches/qalm-pdf keyed by file + page + width. Returns a file:// URI.
enum PdfPageRenderer {
  struct RenderError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
  }

  private static let queue = DispatchQueue(label: "qalm.ink.pdf", qos: .userInitiated)

  static func render(fileUri: String, pageIndex: Int, widthPx: Double, completion: @escaping (Result<String, Error>) -> Void) {
    queue.async {
      do {
        let uri = try renderSync(fileUri: fileUri, pageIndex: pageIndex, widthPx: widthPx)
        completion(.success(uri))
      } catch {
        completion(.failure(error))
      }
    }
  }

  private static func fileURL(from uri: String) -> URL? {
    if uri.hasPrefix("/") { return URL(fileURLWithPath: uri) }
    return URL(string: uri)
  }

  private static func renderSync(fileUri: String, pageIndex: Int, widthPx: Double) throws -> String {
    let width = Int(widthPx.rounded())
    guard width > 0, width <= 16384 else { throw RenderError(message: "Invalid width \(widthPx)") }
    guard let url = fileURL(from: fileUri) else { throw RenderError(message: "Invalid file URI") }

    let fm = FileManager.default
    guard let caches = fm.urls(for: .cachesDirectory, in: .userDomainMask).first else {
      throw RenderError(message: "No caches directory")
    }
    let dir = caches.appendingPathComponent("qalm-pdf", isDirectory: true)
    try fm.createDirectory(at: dir, withIntermediateDirectories: true, attributes: nil)

    // Key includes the file's size and modification date so a replaced file is not served stale.
    var stamp = ""
    if url.isFileURL, let attrs = try? fm.attributesOfItem(atPath: url.path) {
      let size = (attrs[.size] as? NSNumber)?.int64Value ?? 0
      let mod = (attrs[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
      stamp = "|\(size)|\(Int64(mod))"
    }
    let key = fnv1a64(fileUri + stamp)
    let out = dir.appendingPathComponent("\(key)-p\(pageIndex)-w\(width).png")
    if fm.fileExists(atPath: out.path) { return out.absoluteString }

    guard let doc = PDFDocument(url: url) else { throw RenderError(message: "Could not open PDF") }
    guard pageIndex >= 0, pageIndex < doc.pageCount, let page = doc.page(at: pageIndex) else {
      throw RenderError(message: "Page \(pageIndex) out of range")
    }

    let box = page.bounds(for: .mediaBox)
    let rotated = (abs(page.rotation) / 90) % 2 == 1
    let pageW = rotated ? box.height : box.width
    let pageH = rotated ? box.width : box.height
    guard pageW > 0, pageH > 0 else { throw RenderError(message: "Empty page") }
    let height = max(1, Int((Double(width) * Double(pageH) / Double(pageW)).rounded()))
    let size = CGSize(width: width, height: height)

    // PDFPage.thumbnail applies the page rotation and fits the page into `size` (same aspect, so it fills it).
    // Redraw into a scale-1, opaque renderer so the PNG is exactly width × height pixels on white.
    let thumb = page.thumbnail(of: size, for: .mediaBox)
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    format.opaque = true
    let renderer = UIGraphicsImageRenderer(size: size, format: format)
    let data = renderer.pngData { ctx in
      UIColor.white.setFill()
      ctx.fill(CGRect(origin: .zero, size: size))
      thumb.draw(in: CGRect(origin: .zero, size: size))
    }

    let tmp = dir.appendingPathComponent(UUID().uuidString + ".tmp")
    try data.write(to: tmp, options: .atomic)
    if fm.fileExists(atPath: out.path) {
      try? fm.removeItem(at: tmp)
    } else {
      do {
        try fm.moveItem(at: tmp, to: out)
      } catch {
        try? fm.removeItem(at: tmp)
        if !fm.fileExists(atPath: out.path) { throw error }
      }
    }
    return out.absoluteString
  }

  private static func fnv1a64(_ s: String) -> String {
    var hash: UInt64 = 0xcbf29ce484222325
    for byte in s.utf8 {
      hash ^= UInt64(byte)
      hash = hash &* 0x100000001b3
    }
    return String(format: "%016llx", hash)
  }
}
