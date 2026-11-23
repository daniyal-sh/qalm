package app.qalm.ink

import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.ParcelFileDescriptor
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.common.model.DownloadConditions
import com.google.mlkit.common.model.RemoteModelManager
import com.google.mlkit.vision.digitalink.recognition.DigitalInkRecognition
import com.google.mlkit.vision.digitalink.recognition.DigitalInkRecognitionModel
import com.google.mlkit.vision.digitalink.recognition.DigitalInkRecognitionModelIdentifier
import com.google.mlkit.vision.digitalink.recognition.DigitalInkRecognizer
import com.google.mlkit.vision.digitalink.recognition.DigitalInkRecognizerOptions
import com.google.mlkit.vision.digitalink.recognition.Ink
import com.google.mlkit.vision.digitalink.recognition.RecognitionContext
import com.google.mlkit.vision.digitalink.recognition.WritingArea
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

class InkPointRecord : Record {
  @Field var x: Double = 0.0
  @Field var y: Double = 0.0
}

class RecognizeLineRecord : Record {
  @Field var key: String = ""
  @Field var strokes: List<List<InkPointRecord>> = emptyList()
}

class QalmInkModule : Module() {
  private val models = HashMap<String, DigitalInkRecognitionModel>()
  private val recognizers = HashMap<String, DigitalInkRecognizer>()
  private val pdfLock = Any()

  override fun definition() = ModuleDefinition {
    Name("QalmInk")

    AsyncFunction("ensureModel") { lang: String ->
      ensureModel(lang)
    }

    AsyncFunction("recognize") { lines: List<RecognizeLineRecord>, lang: String ->
      ensureModel(lang)
      val recognizer = recognizer(lang)
      lines.mapNotNull { line -> recognizeLine(recognizer, line) }
    }

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
      Prop("input") { view: QalmInkView, v: InputRecord ->
        view.drawWith = v.drawWith
        view.hand = v.hand
        view.palm = v.palm
      }
      Prop("committedIds") { view: QalmInkView, v: List<String> -> view.setCommittedIds(v) }

      OnViewDidUpdateProps { view: QalmInkView -> view.propsChanged() }
    }
  }

  // ---- recognition (ML Kit Digital Ink, model downloaded on demand) ----

  private fun model(lang: String): DigitalInkRecognitionModel = synchronized(models) {
    models.getOrPut(lang) {
      val id = DigitalInkRecognitionModelIdentifier.fromLanguageTag(lang)
        ?: throw CodedException("ERR_LANG", "No ink recognition model for $lang", null)
      DigitalInkRecognitionModel.builder(id).build()
    }
  }

  private fun ensureModel(lang: String) {
    val m = model(lang)
    val manager = RemoteModelManager.getInstance()
    if (!Tasks.await(manager.isModelDownloaded(m))) {
      Tasks.await(manager.download(m, DownloadConditions.Builder().build()))
    }
  }

  private fun recognizer(lang: String): DigitalInkRecognizer = synchronized(recognizers) {
    recognizers.getOrPut(lang) {
      DigitalInkRecognition.getClient(DigitalInkRecognizerOptions.builder(model(lang)).build())
    }
  }

  private fun recognizeLine(recognizer: DigitalInkRecognizer, line: RecognizeLineRecord): Map<String, Any>? {
    val ink = Ink.builder()
    var x0 = Float.MAX_VALUE
    var y0 = Float.MAX_VALUE
    var x1 = -Float.MAX_VALUE
    var y1 = -Float.MAX_VALUE
    for (stroke in line.strokes) {
      if (stroke.isEmpty()) continue
      val s = Ink.Stroke.builder()
      for (p in stroke) {
        val x = p.x.toFloat()
        val y = p.y.toFloat()
        s.addPoint(Ink.Point.create(x, y)) // per-stroke t restarts at 0, so timestamps are left out
        x0 = minOf(x0, x); y0 = minOf(y0, y); x1 = maxOf(x1, x); y1 = maxOf(y1, y)
      }
      ink.addStroke(s.build())
    }
    if (x0 > x1) return null
    val context = RecognitionContext.builder()
      .setPreContext("")
      .setWritingArea(WritingArea(maxOf(1f, x1 - x0), maxOf(1f, y1 - y0)))
      .build()
    // A line that fails is skipped (as on iOS), so one bad line doesn't lose the others.
    val result = try {
      Tasks.await(recognizer.recognize(ink.build(), context))
    } catch (e: Exception) {
      return null
    }
    val best = result.candidates.firstOrNull() ?: return null
    // ML Kit's score is a cost (lower is better) and only some models provide one. Passed through as is (0 when
    // absent), exactly like iOS InkRecognizer.swift.
    return mapOf("key" to line.key, "text" to best.text, "score" to (best.score?.toDouble() ?: 0.0))
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
