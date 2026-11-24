package app.qalm.lecture

import android.content.Intent
import android.media.AudioFormat
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.speech.RecognitionListener
import android.speech.RecognitionPart
import android.speech.RecognitionSupport
import android.speech.RecognitionSupportCallback
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.annotation.RequiresApi
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.FileOutputStream
import java.io.OutputStream
import java.nio.ByteOrder
import java.util.Locale
import java.util.concurrent.Executors

/**
 * qalm lecture mode on Android: transcribes a recorded chunk (AAC, ADTS or M4A) with the on-device SpeechRecognizer
 * (docs/lecture-mode.md §4). The chunk is decoded and resampled to 16 kHz mono PCM as a stream, fed to the recognizer through
 * EXTRA_AUDIO_SOURCE (Android 13+), as a segmented session. Android 14+ also gives word timings; on 13, segment
 * times are spread over the chunk by length. Audio never leaves the device.
 */
class QalmLectureModule : Module() {
  private val main = Handler(Looper.getMainLooper())
  private val io = Executors.newSingleThreadExecutor()

  override fun definition() = ModuleDefinition {
    Name("QalmLecture")

    AsyncFunction("isAvailable") { lang: String, promise: Promise ->
      val ctx = appContext.reactContext
      if (ctx == null) {
        promise.resolve(mapOf("available" to false, "why" to "The app isn't ready yet."))
        return@AsyncFunction
      }
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
        promise.resolve(mapOf("available" to false, "why" to "On-device transcription needs Android 13 or later."))
        return@AsyncFunction
      }
      if (!SpeechRecognizer.isOnDeviceRecognitionAvailable(ctx)) {
        promise.resolve(mapOf("available" to false, "why" to "This device has no on-device speech recognizer."))
        return@AsyncFunction
      }
      main.post { checkSupport(lang, promise) }
    }

    AsyncFunction("transcribeFile") { uri: String, lang: String, promise: Promise ->
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
        promise.reject("E_QALM_LECTURE_UNAVAILABLE", "On-device transcription needs Android 13 or later", null)
        return@AsyncFunction
      }
      io.execute {
        // Opening only reads the track format: the audio itself is streamed into the recognizer (never held whole).
        val src = try {
          PcmSource.open(uri)
        } catch (e: Throwable) {
          promise.reject("E_QALM_LECTURE_DECODE", "Couldn't read the audio: ${e.message}", null)
          return@execute
        }
        main.post { recognize(src, lang, promise) }
      }
    }
  }

  private fun locale(lang: String): String = if (lang.isBlank()) Locale.getDefault().toLanguageTag() else lang

  @RequiresApi(Build.VERSION_CODES.TIRAMISU)
  private fun checkSupport(lang: String, promise: Promise) {
    val ctx = appContext.reactContext ?: return promise.resolve(mapOf("available" to false))
    val sr = SpeechRecognizer.createOnDeviceSpeechRecognizer(ctx)
    val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).putExtra(RecognizerIntent.EXTRA_LANGUAGE, locale(lang))
    sr.checkRecognitionSupport(intent, { it.run() }, object : RecognitionSupportCallback {
      override fun onSupportResult(support: RecognitionSupport) {
        sr.destroy()
        val want = locale(lang).lowercase(Locale.ROOT)
        val installed = support.installedOnDeviceLanguages.map { it.lowercase(Locale.ROOT) }
        val ok = installed.any { it == want || it.substringBefore('-') == want.substringBefore('-') }
        if (ok) promise.resolve(mapOf("available" to true))
        else promise.resolve(mapOf("available" to false, "why" to "Download the speech language in Android settings (Speech recognition) to transcribe on this device."))
      }

      override fun onError(error: Int) {
        sr.destroy()
        // Some recognizers can't answer support queries but still recognize: treat as available.
        promise.resolve(mapOf("available" to true))
      }
    })
  }

  /**
   * A chunk's audio as a stream of 16-bit mono PCM at 16 kHz: MediaCodec decodes it buffer by buffer and `Resampler`
   * downmixes and resamples each buffer as it comes, straight into the recognizer's pipe. Memory stays a few buffers
   * whatever the chunk's length (a whole decoded hour would be hundreds of MB).
   */
  private class PcmSource private constructor(private val ex: MediaExtractor, private val format: MediaFormat) {
    /** The chunk's length from its header (ms), or -1 when the file doesn't say. */
    val durMs: Long = if (format.containsKey(MediaFormat.KEY_DURATION)) format.getLong(MediaFormat.KEY_DURATION) / 1000 else -1

    /** 16 kHz PCM bytes written so far (32 bytes a ms). */
    @Volatile var written: Long = 0

    companion object {
      fun open(uri: String): PcmSource {
        val ex = MediaExtractor()
        try {
          ex.setDataSource(Uri.parse(uri).path ?: uri)
          for (i in 0 until ex.trackCount) {
            val f = ex.getTrackFormat(i)
            if (f.getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true) {
              ex.selectTrack(i)
              return PcmSource(ex, f)
            }
          }
          throw IllegalStateException("no audio track")
        } catch (e: Throwable) {
          ex.release()
          throw e
        }
      }
    }

    /** Decodes everything into `out`. Throws on a decoder error; always releases the codec and the extractor. */
    fun pumpTo(out: OutputStream) {
      val codec = MediaCodec.createDecoderByType(format.getString(MediaFormat.KEY_MIME)!!)
      try {
        codec.configure(format, null, null, 0)
        codec.start()
        val rs = Resampler(format.getInteger(MediaFormat.KEY_SAMPLE_RATE), format.getInteger(MediaFormat.KEY_CHANNEL_COUNT), 16_000)
        val info = MediaCodec.BufferInfo()
        var shorts = ShortArray(0)
        var inputDone = false
        while (true) {
          if (!inputDone) {
            val i = codec.dequeueInputBuffer(10_000)
            if (i >= 0) {
              val n = ex.readSampleData(codec.getInputBuffer(i)!!, 0)
              if (n < 0) {
                codec.queueInputBuffer(i, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                inputDone = true
              } else {
                codec.queueInputBuffer(i, 0, n, ex.sampleTime, 0)
                ex.advance()
              }
            }
          }
          val o = codec.dequeueOutputBuffer(info, 10_000)
          if (o == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
            val f = codec.outputFormat
            rs.setInput(f.getInteger(MediaFormat.KEY_SAMPLE_RATE), f.getInteger(MediaFormat.KEY_CHANNEL_COUNT))
          } else if (o >= 0) {
            val buf = codec.getOutputBuffer(o)!!.order(ByteOrder.LITTLE_ENDIAN)
            buf.position(info.offset)
            buf.limit(info.offset + info.size)
            val n = info.size / 2
            if (shorts.size < n) shorts = ShortArray(n)
            buf.asShortBuffer().get(shorts, 0, n)
            codec.releaseOutputBuffer(o, false)
            written += rs.feed(shorts, n, out)
            if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) break
          }
        }
      } finally {
        runCatching { codec.stop() }
        runCatching { codec.release() }
        runCatching { ex.release() }
      }
    }
  }

  /**
   * Streaming downmix to mono and linear resampling. `t` is the input position (in frames, from the start of the
   * current buffer) of the next output sample; it may be in [-1, 0): between the previous buffer's last frame and this
   * buffer's first.
   */
  private class Resampler(private var rate: Int, private var channels: Int, private val to: Int) {
    private var t = 0.0
    private var prev = 0
    private val outBuf = ByteArray(8192)

    fun setInput(rate: Int, channels: Int) {
      this.rate = rate
      this.channels = channels.coerceAtLeast(1)
    }

    /** Feeds `n` interleaved samples; writes the 16 kHz mono bytes to `out` and returns how many. */
    fun feed(src: ShortArray, n: Int, out: OutputStream): Long {
      val frames = n / channels
      if (frames == 0) return 0
      fun mono(f: Int): Int {
        if (f < 0) return prev
        var sum = 0
        for (c in 0 until channels) sum += src[f * channels + c]
        return sum / channels
      }
      val step = rate.toDouble() / to
      var len = 0
      var total = 0L
      while (t < frames - 1) {
        val a = Math.floor(t).toInt()
        val frac = t - a
        val v = (mono(a) * (1 - frac) + mono(a + 1) * frac).toInt()
        outBuf[len++] = (v and 0xff).toByte()
        outBuf[len++] = ((v shr 8) and 0xff).toByte()
        if (len == outBuf.size) {
          out.write(outBuf, 0, len)
          total += len
          len = 0
        }
        t += step
      }
      if (len > 0) {
        out.write(outBuf, 0, len)
        total += len
      }
      prev = mono(frames - 1)
      t -= frames
      return total
    }
  }

  private class Seg(val text: String, val t0: Int, val t1: Int, val words: List<Map<String, Any>>)

  @RequiresApi(Build.VERSION_CODES.TIRAMISU)
  private fun recognize(src: PcmSource, lang: String, promise: Promise) {
    val ctx = appContext.reactContext ?: return promise.reject("E_QALM_LECTURE_UNAVAILABLE", "No context", null)
    val pipe = ParcelFileDescriptor.createPipe()
    val read = pipe[0]
    val write = pipe[1]
    val sr = SpeechRecognizer.createOnDeviceSpeechRecognizer(ctx)
    val segs = mutableListOf<Seg>()
    var settled = false
    fun finish(err: String?) {
      if (settled) return
      settled = true
      sr.destroy()
      runCatching { read.close() }
      if (err != null) {
        promise.reject("E_QALM_LECTURE_FAILED", err, null)
        return
      }
      // The length actually decoded (a crash-recovered file's header can be missing).
      promise.resolve(timed(segs, (src.written / 32).toInt()))
    }
    sr.setRecognitionListener(object : RecognitionListener {
      override fun onReadyForSpeech(params: Bundle?) {}
      override fun onBeginningOfSpeech() {}
      override fun onRmsChanged(rmsdB: Float) {}
      override fun onBufferReceived(buffer: ByteArray?) {}
      override fun onEndOfSpeech() {}
      override fun onPartialResults(partialResults: Bundle?) {}
      override fun onEvent(eventType: Int, params: Bundle?) {}
      override fun onSegmentResults(segmentResults: Bundle) {
        segs.add(segmentOf(segmentResults))
      }
      override fun onEndOfSegmentedSession() = finish(null)
      override fun onResults(results: Bundle?) {
        if (results != null) segmentOf(results).takeIf { it.text.isNotBlank() }?.let { segs.add(it) }
        finish(null)
      }
      override fun onError(error: Int) {
        // No speech in the chunk: no lines, not a failure.
        if (error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) finish(null)
        else finish("recognizer error $error")
      }
    })
    val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
      .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
      .putExtra(RecognizerIntent.EXTRA_LANGUAGE, locale(lang))
      .putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
      .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE, read)
      .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT, 1)
      .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_ENCODING, AudioFormat.ENCODING_PCM_16BIT)
      .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE, 16_000)
      .putExtra(RecognizerIntent.EXTRA_SEGMENTED_SESSION, RecognizerIntent.EXTRA_AUDIO_SOURCE)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) intent.putExtra(RecognizerIntent.EXTRA_REQUEST_WORD_TIMING, true)
    sr.startListening(intent)
    io.execute {
      var failed: String? = null
      try {
        FileOutputStream(write.fileDescriptor).use { src.pumpTo(it) }
      } catch (e: java.io.IOException) {
        // The recognizer closed its end early (an error): it reports through the listener.
      } catch (e: Throwable) {
        // A decoder error, or out of memory: never a crash; the chunk just isn't transcribed here.
        failed = "Couldn't read the audio: ${e.message ?: e.javaClass.simpleName}"
      } finally {
        runCatching { write.close() }
      }
      if (failed != null) main.post { finish(failed) }
    }
    // A stuck recognizer never holds a chunk forever (twice its length; an hour if the file doesn't say).
    val limit = if (src.durMs > 0) src.durMs * 2 else 3_600_000L
    main.postDelayed({ finish(if (segs.isEmpty()) "timed out" else null) }, limit.coerceAtLeast(60_000L))
  }

  private fun segmentOf(b: Bundle): Seg {
    val text = b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      @Suppress("DEPRECATION")
      val parts: List<RecognitionPart>? = b.getParcelableArrayList(SpeechRecognizer.RECOGNITION_PARTS)
      if (!parts.isNullOrEmpty()) {
        val words = parts.map { p ->
          val w = p.formattedText ?: p.rawText
          mapOf<String, Any>("w" to w, "t0" to p.timestampMillis.toInt(), "t1" to p.timestampMillis.toInt())
        }
        // A word ends where the next begins (RecognitionPart has only a start time).
        val fixed = words.mapIndexed { i, w -> if (i + 1 < words.size) w + ("t1" to words[i + 1]["t0"]!!) else w + ("t1" to ((w["t0"] as Int) + 400)) }
        return Seg(text, fixed.first()["t0"] as Int, fixed.last()["t1"] as Int, fixed)
      }
    }
    return Seg(text, -1, -1, emptyList())
  }

  /** Segments with times; ones without (Android 13) are spread over the chunk by their length. */
  private fun timed(segs: List<Seg>, durMs: Int): List<Map<String, Any>> {
    val kept = segs.filter { it.text.isNotBlank() }
    val total = kept.sumOf { it.text.length }.coerceAtLeast(1)
    var at = 0
    return kept.map { s ->
      val span = (durMs.toLong() * s.text.length / total).toInt()
      val t0 = if (s.t0 >= 0) s.t0 else at
      val t1 = if (s.t1 >= 0) s.t1 else at + span
      at += span
      val m = mutableMapOf<String, Any>("t0" to t0, "t1" to t1, "text" to s.text)
      if (s.words.isNotEmpty()) m["words"] = s.words
      m
    }
  }
}
