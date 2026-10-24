package gg.vlm.spaces.api

import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

sealed interface ApiResult<out T> {
  data class Ok<T>(val value: T) : ApiResult<T>
  data object NotFound : ApiResult<Nothing>
  data object RateLimited : ApiResult<Nothing>
  /** The server could not be reached (no network, DNS, timeout). */
  data object Offline : ApiResult<Nothing>
  data class Failed(val status: Int) : ApiResult<Nothing>
}

/**
 * The AR endpoints of a VLM server. A bearer token is sent only when one is given. Tokens are never logged.
 * Safe to call from any dispatcher: requests run on IO.
 */
class ArApi(baseUrl: String, private val userAgentVersion: Int = 1) {
  private val base = baseUrl.trim().trimEnd('/')

  /** `GET /api/ar/markers/by-code/:code` */
  suspend fun lookup(code: String): ApiResult<MarkerLookup> =
      get("/api/ar/markers/by-code/${enc(code)}", null, 15_000, ::parseLookup)

  /** `GET /api/ar/spaces/:id/feed?since=`: the server holds the request up to 25 s until the version changes. */
  suspend fun feed(spaceId: String, since: String, token: String? = null): ApiResult<ArFeedSnapshot> =
      get("/api/ar/spaces/${enc(spaceId)}/feed?since=${enc(since)}", token, 40_000, ::parseFeed)

  private suspend fun <T> get(path: String, token: String?, readTimeoutMs: Int, parse: (String) -> T?): ApiResult<T> =
      withContext(Dispatchers.IO) {
        val c =
            try {
              URL(base + path).openConnection() as HttpURLConnection
            } catch (e: java.io.IOException) {
              return@withContext ApiResult.Offline
            }
        try {
          c.connectTimeout = 15_000
          c.readTimeout = readTimeoutMs
          c.useCaches = false
          c.setRequestProperty("X-VLM-App-Version", userAgentVersion.toString())
          if (!token.isNullOrEmpty()) c.setRequestProperty("Authorization", "Bearer $token")
          val code = c.responseCode
          when {
            code == 404 -> ApiResult.NotFound
            code == 429 -> ApiResult.RateLimited
            code in 200..299 -> {
              val body = c.inputStream.bufferedReader().use { it.readText() }
              parse(body)?.let { ApiResult.Ok(it) } ?: ApiResult.Failed(code)
            }
            else -> ApiResult.Failed(code)
          }
        } catch (e: java.io.IOException) {
          ApiResult.Offline
        } finally {
          c.disconnect()
        }
      }

  private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")
}
