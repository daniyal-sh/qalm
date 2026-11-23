package app.qalm.ink

import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.ParcelFileDescriptor
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest

class PageSizeRecord : Record {
  @Field var w: Double = 595.0
  @Field var h: Double = 842.0
}

class InputRecord : Record {
  @Field var drawWith: String = "pen"
  @Field var hand: String = "right"
  @Field var palm: String = "standard"
}

class QalmInkModule : Module() {
  private val pdfLock = Any()

  override fun definition() = ModuleDefinition {
    Name("QalmInk")

    AsyncFunction("renderPdfPage") { fileUri: String, pageIndex: Int, widthPx: Double ->
      renderPdfPage(fileUri, pageIndex, Math.round(widthPx).toInt())
    }

    View(QalmInkView::class) {
      Events("onStrokeEnd", "onErase", "onLasso", "onPenButton", "onRejectedTouch")

      Prop("pageSize") { view: QalmInkView, v: PageSizeRecord ->
        view.pageW = if (v.w > 0) v.w else 595.0
        view.pageH = if (v.h > 0) v.h else 842.0
      }
      Prop("tool") { view: QalmInkView, v: String -> view.tool = v }
      Prop("color") { view: QalmInkView, v: String -> view.colorString = v }
      Prop("strokeWidth") { view: QalmInkView, v: Double -> view.strokeWidth = v } // not "width": Fabric would read that as layout width
      Prop("penStyle") { view: QalmInkView, v: String? -> view.penStyle = v ?: "fountain" }
      Prop("smoothing") { view: QalmInkView, v: Int? -> view.smoothing = (v ?: 0).coerceIn(0, 3) }
      Prop("lassoMode") { view: QalmInkView, v: String? -> view.lassoMode = if (v == "rect") "rect" else "free" }
      Prop("input") { view: QalmInkView, v: InputRecord ->
        view.drawWith = v.drawWith
        view.hand = v.hand
        view.palm = v.palm
      }
      Prop("committedIds") { view: QalmInkView, v: List<String> -> view.setCommittedIds(v) }

      OnViewDidUpdateProps { view: QalmInkView -> view.propsChanged() }
    }
  }

  // ---- PDF (android.graphics.pdf.PdfRenderer → cached PNG in cacheDir) ----

  private fun renderPdfPage(fileUri: String, pageIndex: Int, widthPx: Int): String {
    if (widthPx <= 0 || widthPx > 16384) throw CodedException("ERR_PDF_WIDTH", "Invalid width $widthPx", null) // as iOS
    val ctx = appContext.reactContext ?: throw CodedException("ERR_CONTEXT", "No React context", null)
    val uri = Uri.parse(fileUri)
    val stamp = if (uri.scheme == "file" || uri.scheme == null) File(uri.path ?: fileUri).lastModified() else 0L
    val key = sha1("$fileUri|$stamp|$pageIndex|$widthPx")
    val dir = File(ctx.cacheDir, "qalm-pdf").apply { mkdirs() }
    val out = File(dir, "$key.png")
    if (out.exists() && out.length() > 0) return Uri.fromFile(out).toString()

    val pfd: ParcelFileDescriptor = when (uri.scheme) {
      "content" -> ctx.contentResolver.openFileDescriptor(uri, "r")
      else -> ParcelFileDescriptor.open(File(uri.path ?: fileUri), ParcelFileDescriptor.MODE_READ_ONLY)
    } ?: throw CodedException("ERR_PDF_OPEN", "Cannot open $fileUri", null)

    synchronized(pdfLock) {
      pfd.use { fd ->
        PdfRenderer(fd).use { renderer ->
          if (pageIndex < 0 || pageIndex >= renderer.pageCount) {
            throw CodedException("ERR_PDF_PAGE", "Page $pageIndex out of range (${renderer.pageCount} pages)", null)
          }
          renderer.openPage(pageIndex).use { page ->
            val w = maxOf(1, widthPx)
            val h = maxOf(1, Math.round(w.toDouble() * page.height / page.width).toInt())
            val bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
            bitmap.eraseColor(Color.WHITE)
            page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
            val tmp = File(dir, "$key.tmp")
            FileOutputStream(tmp).use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            bitmap.recycle()
            tmp.renameTo(out)
          }
        }
      }
    }
    return Uri.fromFile(out).toString()
  }

  private fun sha1(s: String): String =
    MessageDigest.getInstance("SHA-1").digest(s.toByteArray()).joinToString("") { "%02x".format(it) }
}
