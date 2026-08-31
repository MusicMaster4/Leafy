package app.leafy.financas

import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.Bundle
import android.os.Build
import android.os.ParcelFileDescriptor
import android.provider.Settings
import android.provider.OpenableColumns
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.content.FileProvider
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
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
    private const val MAX_RELEASE_BYTES = 64L * 1024L
    private const val MAX_UPDATE_BYTES = 200L * 1024L * 1024L
    private const val MAX_UPDATE_REDIRECTS = 5
  }

  private data class PendingEvent(val name: String, val json: String)

  private val receiptExecutor = Executors.newSingleThreadExecutor()
  private val updateExecutor = Executors.newSingleThreadExecutor()
  @Volatile private var pendingEvent: PendingEvent? = null
  @Volatile private var pendingUpdateFile: File? = null
  private var leafyWebView: WebView? = null

  private external fun initTlsVerifier()

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    initTlsVerifier()
  }

  override fun onWebViewCreate(webView: WebView) {
    leafyWebView = webView
    webView.addJavascriptInterface(UpdateBridge(), "LeafyAndroid")
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
    updateExecutor.shutdownNow()
    super.onDestroy()
  }

  override fun onResume() {
    super.onResume()
    val update = pendingUpdateFile ?: return
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || packageManager.canRequestPackageInstalls()) {
      pendingUpdateFile = null
      openPackageInstaller(update)
    }
  }

  private inner class UpdateBridge {
    @JavascriptInterface
    fun checkForUpdates() {
      updateExecutor.execute { checkForAndroidUpdate() }
    }

    @JavascriptInterface
    fun installUpdate(downloadUrl: String) {
      if (!isOfficialUpdateUrl(downloadUrl, false)) {
        emitUpdateError("Leafy refused an untrusted update address.")
        return
      }
      updateExecutor.execute { downloadAndInstallUpdate(downloadUrl) }
    }
  }

  private data class ReleaseVersion(val core: List<Long>, val testing: Long?) : Comparable<ReleaseVersion> {
    override fun compareTo(other: ReleaseVersion): Int {
      core.zip(other.core).firstOrNull { (left, right) -> left != right }?.let { (left, right) ->
        return left.compareTo(right)
      }
      return when {
        testing == null && other.testing != null -> 1
        testing != null && other.testing == null -> -1
        else -> (testing ?: 0).compareTo(other.testing ?: 0)
      }
    }
  }

  private fun parseReleaseVersion(value: String): ReleaseVersion? {
    val match = Regex("^v?(\\d+)\\.(\\d+)\\.(\\d+)(?:-testing\\.(\\d+))?$").matchEntire(value.trim())
      ?: return null
    return try {
      ReleaseVersion(
        listOf(match.groupValues[1].toLong(), match.groupValues[2].toLong(), match.groupValues[3].toLong()),
        match.groupValues[4].takeIf { it.isNotEmpty() }?.toLong(),
      )
    } catch (_: NumberFormatException) { null }
  }

  private fun checkForAndroidUpdate() {
    var connection: HttpURLConnection? = null
    try {
      val currentVersion = BuildConfig.VERSION_NAME
      val current = requireNotNull(parseReleaseVersion(currentVersion)) { "Invalid installed version" }
      val testingChannel = current.testing != null
      val endpoint = if (testingChannel) {
        "https://api.github.com/repos/MusicMaster4/Leafy/releases?per_page=1"
      } else {
        "https://api.github.com/repos/MusicMaster4/Leafy/releases/latest"
      }
      connection = (URL(endpoint).openConnection() as HttpURLConnection).apply {
        instanceFollowRedirects = false
        connectTimeout = 4_000
        readTimeout = 6_000
        setRequestProperty("Accept", "application/vnd.github+json")
        setRequestProperty("User-Agent", "Leafy Android update checker")
      }
      require(connection.responseCode in 200..299) { "Update server returned ${connection.responseCode}" }
      val expected = connection.contentLengthLong
      require(expected <= MAX_RELEASE_BYTES) { "Update response is too large" }
      val output = ByteArrayOutputStream()
      connection.inputStream.use { input ->
        val buffer = ByteArray(8 * 1024)
        while (true) {
          val count = input.read(buffer)
          if (count < 0) break
          require(output.size() + count <= MAX_RELEASE_BYTES) { "Update response is too large" }
          output.write(buffer, 0, count)
        }
      }
      val body = output.toString(Charsets.UTF_8.name())
      val release = if (testingChannel) JSONArray(body).getJSONObject(0) else JSONObject(body)
      val tag = release.getString("tag_name")
      val latest = requireNotNull(parseReleaseVersion(tag)) { "Invalid release version" }
      val expectedApk = if (release.optBoolean("prerelease")) "leafy-beta.apk" else "leafy.apk"
      val assets = release.getJSONArray("assets")
      var apkUrl: String? = null
      for (index in 0 until assets.length()) {
        val asset = assets.getJSONObject(index)
        if (asset.optString("name") == expectedApk) {
          val candidate = asset.getString("browser_download_url")
          if (isOfficialUpdateUrl(candidate, false)) apkUrl = candidate
          break
        }
      }
      val payload = JSONObject()
        .put("currentVersion", currentVersion)
        .put("latestVersion", tag.removePrefix("v"))
        .put("available", latest > current)
        .put("apkUrl", apkUrl ?: JSONObject.NULL)
        .put("updaterUrl", "https://github.com/MusicMaster4/Leafy/releases/download/$tag/latest.json")
      emitWebEvent("leafy:update-check-result", payload)
    } catch (_: Exception) {
      emitWebEvent("leafy:update-check-error", JSONObject().put("message", "Could not reach GitHub Releases."))
    } finally {
      connection?.disconnect()
    }
  }

  private fun downloadAndInstallUpdate(downloadUrl: String) {
    val directory = File(cacheDir, "updates").apply { mkdirs() }
    val destination = File(directory, "leafy-update.apk")
    val temporary = File(directory, "leafy-update.apk.part")
    try {
      var current = downloadUrl
      var redirects = 0
      var connection: HttpURLConnection
      while (true) {
        val allowRedirectHost = redirects > 0
        require(isOfficialUpdateUrl(current, allowRedirectHost)) { "Untrusted update redirect" }
        connection = (URL(current).openConnection() as HttpURLConnection).apply {
          instanceFollowRedirects = false
          connectTimeout = 10_000
          readTimeout = 30_000
          setRequestProperty("Accept", "application/octet-stream")
          setRequestProperty("User-Agent", "Leafy Android updater")
        }
        val status = connection.responseCode
        if (status !in 300..399) break
        val location = connection.getHeaderField("Location") ?: throw IllegalStateException("Missing update redirect")
        connection.disconnect()
        redirects += 1
        require(redirects <= MAX_UPDATE_REDIRECTS) { "Too many update redirects" }
        current = URL(URL(current), location).toString()
      }
      require(connection.responseCode in 200..299) { "Update server returned ${connection.responseCode}" }
      val expected = connection.contentLengthLong
      require(expected in 1..MAX_UPDATE_BYTES) { "Invalid update size" }
      connection.inputStream.use { input ->
        FileOutputStream(temporary).use { output ->
          val buffer = ByteArray(64 * 1024)
          var total = 0L
          while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            total += count
            require(total <= MAX_UPDATE_BYTES) { "Update is too large" }
            output.write(buffer, 0, count)
            emitUpdateProgress(((total * 100L) / expected).toInt().coerceIn(0, 100))
          }
          require(total == expected) { "Incomplete update download" }
        }
      }
      connection.disconnect()
      if (destination.exists()) destination.delete()
      require(temporary.renameTo(destination)) { "Could not prepare the update" }
      runOnUiThread { requestPackageInstall(destination) }
    } catch (_: Exception) {
      temporary.delete()
      emitUpdateError("Leafy could not securely download this update.")
    }
  }

  private fun isOfficialUpdateUrl(value: String, allowRedirectHost: Boolean): Boolean = try {
    val url = URL(value)
    if (url.protocol != "https" || url.userInfo != null || url.port != -1 || url.ref != null) false
    else if (!allowRedirectHost) {
      url.query == null && url.host == "github.com" &&
        url.path.startsWith("/MusicMaster4/Leafy/releases/download/v") &&
        (url.path.endsWith("/leafy.apk") || url.path.endsWith("/leafy-beta.apk"))
    } else {
      url.host.endsWith(".githubusercontent.com") || url.host == "githubusercontent.com"
    }
  } catch (_: Exception) { false }

  private fun requestPackageInstall(file: File) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !packageManager.canRequestPackageInstalls()) {
      pendingUpdateFile = file
      emitUpdateStatus("permission")
      startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName")))
      return
    }
    openPackageInstaller(file)
  }

  private fun openPackageInstaller(file: File) {
    try {
      val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", file)
      startActivity(Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, "application/vnd.android.package-archive")
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
      })
      emitUpdateStatus("installing")
    } catch (_: ActivityNotFoundException) {
      emitUpdateError("Android could not open the package installer.")
    }
  }

  private fun emitUpdateProgress(percent: Int) {
    emitWebEvent("leafy:update-progress", JSONObject().put("percent", percent))
  }

  private fun emitUpdateStatus(status: String) {
    emitWebEvent("leafy:update-status", JSONObject().put("status", status))
  }

  private fun emitUpdateError(message: String) {
    emitWebEvent("leafy:update-error", JSONObject().put("message", message))
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

  private fun emitWebEvent(name: String, payload: JSONObject) {
    val webView = leafyWebView ?: return
    val quotedName = JSONObject.quote(name)
    val quotedJson = JSONObject.quote(payload.toString())
    webView.post {
      webView.evaluateJavascript(
        "window.dispatchEvent(new CustomEvent($quotedName,{detail:JSON.parse($quotedJson)}));",
        null,
      )
    }
  }

  // Shared files can arrive before React mounts, so only those events need the
  // readiness queue. Update events are initiated by React and are dispatched
  // directly to the listeners that started the operation.
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
