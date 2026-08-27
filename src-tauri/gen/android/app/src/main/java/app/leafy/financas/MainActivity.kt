package app.leafy.financas

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.Bundle
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import java.util.concurrent.Executors
import kotlin.math.max
import kotlin.math.roundToInt

class MainActivity : TauriActivity() {
  companion object {
    private const val MAX_SHARED_BYTES = 10L * 1024L * 1024L
    private const val MAX_PDF_PAGES = 10
    private const val MAX_TEXT_CHARS = 150_000
    private const val MAX_IMAGE_EDGE = 2048
    private const val SHARE_CONSUMED = "app.leafy.financas.SHARE_CONSUMED"
  }

  private data class PendingEvent(val name: String, val json: String)

  private val receiptExecutor = Executors.newSingleThreadExecutor()
  @Volatile private var pendingEvent: PendingEvent? = null
  private var leafyWebView: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    leafyWebView = webView
    receiveShareIntent(intent)
    dispatchPendingEvent()
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    receiveShareIntent(intent)
  }

  override fun onDestroy() {
    leafyWebView = null
    receiptExecutor.shutdownNow()
    super.onDestroy()
  }

  private fun receiveShareIntent(sharedIntent: Intent?) {
    if (sharedIntent?.action != Intent.ACTION_SEND || sharedIntent.getBooleanExtra(SHARE_CONSUMED, false)) return
    sharedIntent.putExtra(SHARE_CONSUMED, true)
    val mimeType = sharedIntent.type.orEmpty().lowercase()
    val name = displayName(sharedUri(sharedIntent)) ?: when {
      mimeType == "application/pdf" -> "Shared receipt.pdf"
      mimeType.startsWith("image/") -> "Shared receipt image"
      else -> "Shared receipt text"
    }

    if (mimeType == "text/plain") {
      val extraText = sharedIntent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()?.trim()
      if (!extraText.isNullOrEmpty()) {
        emitReceipt(name, mimeType, extraText.take(MAX_TEXT_CHARS))
        return
      }
    }

    val uri = sharedUri(sharedIntent)
    if (uri == null || uri.scheme != "content") {
      emitError("Leafy only accepts securely shared content files.")
      return
    }

    receiptExecutor.execute {
      try {
        when {
          mimeType == "application/pdf" -> readPdf(uri, name, mimeType)
          mimeType.startsWith("image/") -> readImage(uri, name, mimeType)
          mimeType == "text/plain" -> readPlainText(uri, name, mimeType)
          else -> emitError("This file type is not supported. Share a PDF, receipt image, or plain text.")
        }
      } catch (_: SecurityException) {
        emitError("Leafy could not access this shared file.")
      } catch (_: Exception) {
        emitError("Leafy could not safely read this receipt.")
      }
    }
  }

  @Suppress("DEPRECATION")
  private fun sharedUri(intent: Intent): Uri? = if (android.os.Build.VERSION.SDK_INT >= 33) {
    intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
  } else {
    intent.getParcelableExtra(Intent.EXTRA_STREAM) as? Uri
  }

  private fun displayName(uri: Uri?): String? {
    if (uri == null || uri.scheme != "content") return null
    return try {
      contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
        if (cursor.moveToFirst()) cursor.getString(0)?.take(255) else null
      }
    } catch (_: Exception) { null }
  }

  private fun copyToPrivateCache(uri: Uri, suffix: String): File {
    val file = File.createTempFile("leafy-receipt-", suffix, cacheDir)
    try {
      contentResolver.openInputStream(uri).use { input ->
        requireNotNull(input) { "Shared file is unavailable" }
        FileOutputStream(file).use { output ->
          val buffer = ByteArray(16 * 1024)
          var total = 0L
          while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            total += count
            require(total <= MAX_SHARED_BYTES) { "Shared file is too large" }
            output.write(buffer, 0, count)
          }
        }
      }
      return file
    } catch (error: Exception) {
      file.delete()
      throw error
    }
  }

  private fun readPlainText(uri: Uri, name: String, mimeType: String) {
    val file = copyToPrivateCache(uri, ".txt")
    try {
      val text = file.inputStream().bufferedReader(Charsets.UTF_8).use { it.readText() }.take(MAX_TEXT_CHARS)
      require(text.isNotBlank()) { "Receipt text is empty" }
      emitReceipt(name, mimeType, text)
    } finally { file.delete() }
  }

  private fun readImage(uri: Uri, name: String, mimeType: String) {
    val file = copyToPrivateCache(uri, ".image")
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(file.absolutePath, bounds)
    require(bounds.outWidth > 0 && bounds.outHeight > 0) { "Invalid image" }
    var sample = 1
    while (max(bounds.outWidth, bounds.outHeight) / sample > MAX_IMAGE_EDGE) sample *= 2
    val bitmap = BitmapFactory.decodeFile(file.absolutePath, BitmapFactory.Options().apply { inSampleSize = sample })
    if (bitmap == null) {
      file.delete()
      throw IllegalArgumentException("Invalid image")
    }
    recognizeBitmap(bitmap) { result ->
      bitmap.recycle()
      file.delete()
      result.fold(
        onSuccess = { emitReceipt(name, mimeType, it) },
        onFailure = { emitError("Leafy could not find readable text in this image.") },
      )
    }
  }

  private fun readPdf(uri: Uri, name: String, mimeType: String) {
    val file = copyToPrivateCache(uri, ".pdf")
    val descriptor = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
    val renderer = PdfRenderer(descriptor)
    if (renderer.pageCount == 0) {
      renderer.close(); descriptor.close(); file.delete()
      throw IllegalArgumentException("Empty PDF")
    }
    val pages = minOf(renderer.pageCount, MAX_PDF_PAGES)
    val recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
    val text = StringBuilder()

    fun closeAll() {
      recognizer.close()
      renderer.close()
      descriptor.close()
      file.delete()
    }

    fun readPage(index: Int) {
      if (index >= pages) {
        val result = text.toString().take(MAX_TEXT_CHARS).trim()
        closeAll()
        if (result.isEmpty()) emitError("Leafy could not find readable text in this PDF.")
        else emitReceipt(name, mimeType, result)
        return
      }
      val page = renderer.openPage(index)
      val scale = minOf(2.0, 1600.0 / max(page.width, page.height))
      val width = max(1, (page.width * scale).roundToInt())
      val height = max(1, (page.height * scale).roundToInt())
      val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
      bitmap.eraseColor(android.graphics.Color.WHITE)
      page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
      page.close()
      recognizer.process(InputImage.fromBitmap(bitmap, 0))
        .addOnSuccessListener(receiptExecutor) { result ->
          if (result.text.isNotBlank()) text.append(result.text).append('\n')
          bitmap.recycle()
          readPage(index + 1)
        }
        .addOnFailureListener(receiptExecutor) {
          bitmap.recycle()
          closeAll()
          emitError("Leafy could not read this PDF locally.")
        }
    }

    readPage(0)
  }

  private fun recognizeBitmap(bitmap: Bitmap, callback: (Result<String>) -> Unit) {
    val recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
    recognizer.process(InputImage.fromBitmap(bitmap, 0))
      .addOnSuccessListener(receiptExecutor) { result ->
        recognizer.close()
        val text = result.text.take(MAX_TEXT_CHARS).trim()
        if (text.isBlank()) callback(Result.failure(IllegalArgumentException("No text")))
        else callback(Result.success(text))
      }
      .addOnFailureListener(receiptExecutor) { error ->
        recognizer.close()
        callback(Result.failure(error))
      }
  }

  private fun emitReceipt(name: String, mimeType: String, text: String) {
    val payload = JSONObject()
      .put("id", UUID.randomUUID().toString())
      .put("name", name.take(255))
      .put("mimeType", mimeType.take(100))
      .put("text", text.take(MAX_TEXT_CHARS))
    queueEvent("leafy:shared-receipt", payload)
  }

  private fun emitError(message: String) {
    queueEvent("leafy:share-error", JSONObject().put("message", message))
  }

  private fun queueEvent(name: String, payload: JSONObject) {
    pendingEvent = PendingEvent(name, payload.toString())
    dispatchPendingEvent()
  }

  private fun dispatchPendingEvent(attempt: Int = 0) {
    val webView = leafyWebView ?: return
    val event = pendingEvent ?: return
    webView.post {
      webView.evaluateJavascript("window.__leafyShareReady === true") { ready ->
        if (ready == "true") {
          val name = JSONObject.quote(event.name)
          val json = JSONObject.quote(event.json)
          webView.evaluateJavascript(
            "window.dispatchEvent(new CustomEvent($name,{detail:JSON.parse($json)}));",
            null,
          )
          if (pendingEvent == event) pendingEvent = null
        } else if (attempt < 40) {
          webView.postDelayed({ dispatchPendingEvent(attempt + 1) }, 250)
        }
      }
    }
  }
}
