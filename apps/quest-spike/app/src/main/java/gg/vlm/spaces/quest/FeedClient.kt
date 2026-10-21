package gg.vlm.spaces.quest

import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject

data class FeedStatus(
    val state: String = "Idle",
    /** First 8 hex chars of the scene version. */
    val version: String? = null,
    val lastError: String? = null,
)

/**
 * Long-polls `GET {feedUrl}/api/hyperfy/feed?since=<version>` (see packages/vlm-hyperfy-app/src/poller.ts). Each answer
 * is a whole snapshot; `onSnapshot` fires only when the version changes. Failures back off (doubling, 1 s to 30 s) and
 * keep the last snapshot, except a 404 (scene gone), which clears it once. The world key only ever goes in the
 * Authorization header; it is never logged or shown. Callbacks run on the main thread.
 */
class FeedClient(
    private val scope: CoroutineScope,
    private val onStatus: (FeedStatus) -> Unit,
    private val onSnapshot: (JsonObject?) -> Unit,
) {
  private var job: Job? = null

  fun start(feedUrl: String, worldKey: String) {
    stop()
    val base = feedUrl.trim().trimEnd('/')
    val key = worldKey.trim()
    if (key.isEmpty()) return onStatus(FeedStatus("Missing world key", lastError = "Paste a world key below"))
    if (!base.startsWith("http://") && !base.startsWith("https://"))
        return onStatus(FeedStatus("Bad feed URL", lastError = "Feed URL must start with http(s)://"))
    onStatus(FeedStatus("Connecting…"))
    job = scope.launch { loop("$base/api/hyperfy/feed", key) }
  }

  fun stop() {
    job?.cancel()
    job = null
  }

  private suspend fun loop(endpoint: String, key: String) {
    var version = ""
    var shownVersion: String? = null
    var wait = 0.0
    while (scope.isActive) {
      val (code, body) =
          try {
            withContext(Dispatchers.IO) { get("$endpoint?since=${URLEncoder.encode(version, "UTF-8")}", key) }
          } catch (e: Exception) {
            if (!scope.isActive) return
            -1 to (e.message ?: "Network error")
          }
      val snap = if (code == 200) parse(body) else null
      if (snap != null) {
        wait = 0.0
        if (snap.first != version) {
          version = snap.first
          shownVersion = version.take(8)
          onSnapshot(snap.second)
        }
        onStatus(FeedStatus("Live", shownVersion))
        continue
      }
      val failure =
          when (code) {
            -1 -> body
            200 -> "Unexpected feed response"
            401 -> "Invalid world key (401)"
            404 -> {
              if (version.isNotEmpty()) {
                version = ""
                shownVersion = null
                onSnapshot(null)
              }
              "Scene not found (404)"
            }
            429 -> "Rate limited (429)"
            else -> "HTTP $code"
          }
      wait = minOf(maxOf(wait * 2, 1.0), 30.0)
      onStatus(FeedStatus("Retrying in ${wait.toInt()} s", shownVersion, failure))
      delay((wait * 1000).toLong())
    }
  }

  private fun get(url: String, key: String): Pair<Int, String> {
    val c = URL(url).openConnection() as HttpURLConnection
    try {
      c.connectTimeout = 15_000
      c.readTimeout = 40_000 // the server holds a long poll up to 25 s
      c.useCaches = false
      c.setRequestProperty("Authorization", "Bearer $key")
      c.setRequestProperty("X-VLM-App-Version", "1")
      val code = c.responseCode
      val body = (if (code < 400) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
      return code to body
    } finally {
      c.disconnect()
    }
  }

  companion object {
    /** `{ v: 1, version: string, scene: object | null }` */
    fun parse(body: String): Pair<String, JsonObject?>? {
      val o = runCatching { Json.parseToJsonElement(body).jsonObject }.getOrNull() ?: return null
      if ((o["v"] as? JsonPrimitive)?.intOrNull != 1) return null
      val version = (o["version"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
      if ("scene" !in o) return null
      return version to (o["scene"] as? JsonObject)
    }
  }
}
