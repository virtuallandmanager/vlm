package gg.vlm.spaces.api

import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

sealed interface ApiResult<out T> {
  data class Ok<T>(val value: T) : ApiResult<T>
  data object NotFound : ApiResult<Nothing>
  data object RateLimited : ApiResult<Nothing>
  /** The server could not be reached (no network, DNS, timeout). */
  data object Offline : ApiResult<Nothing>
  data class Failed(val status: Int) : ApiResult<Nothing>
}

/**
 * How a headset-secret call (pairing and the device routes) ended. A 401 is told apart by the server's error code:
 * [BadSecret], [Revoked], else [Unauthorized] (an expired or missing token on a bearer call).
 */
sealed interface DeviceCall<out T> {
  data class Ok<T>(val value: T) : DeviceCall<T>
  /** 404: an expired code, an unknown device or space. */
  data object NotFound : DeviceCall<Nothing>
  /** 403: the approver can no longer build on that space. */
  data object NoAccess : DeviceCall<Nothing>
  data object BadSecret : DeviceCall<Nothing>
  data object Revoked : DeviceCall<Nothing>
  data object Unauthorized : DeviceCall<Nothing>
  data object RateLimited : DeviceCall<Nothing>
  data object Offline : DeviceCall<Nothing>
  data class Failed(val status: Int) : DeviceCall<Nothing>
}

/** What became of an analytics batch: taken, worth sending again later, or refused for good. */
enum class AnalyticsPost { Sent, Retry, Drop }

/**
 * The fate of a batch the server answered with HTTP [status]: a 4xx other than 408 (request timeout) and 429 will
 * never be taken.
 */
fun analyticsPostFor(status: Int): AnalyticsPost =
    when {
      status in 200..299 -> AnalyticsPost.Sent
      status == 408 || status == 429 -> AnalyticsPost.Retry
      status in 400..499 -> AnalyticsPost.Drop
      else -> AnalyticsPost.Retry
    }

/**
 * The AR endpoints of a VLM server. A bearer token is sent only when one is given. Tokens are never logged.
 * Safe to call from any dispatcher: requests run on IO.
 */
class ArApi(baseUrl: String, private val userAgentVersion: Int = 1) {
  private val base = baseUrl.trim().trimEnd('/')

  /** `GET /api/ar/markers/by-code/:code`; a builder's [token] also finds unpublished spaces it may edit. */
  suspend fun lookup(code: String, token: String? = null): ApiResult<MarkerLookup> =
      get("/api/ar/markers/by-code/${enc(code)}", token, 15_000, ::parseLookup)

  /** `GET /api/ar/spaces/:id/feed?since=`: the server holds the request up to 25 s until the version changes. */
  suspend fun feed(spaceId: String, since: String, token: String? = null): ApiResult<ArFeedSnapshot> =
      get("/api/ar/spaces/${enc(spaceId)}/feed?since=${enc(since)}", token, 40_000, ::parseFeed)

  /** `POST /api/ar/spaces/:id/analytics` (see [analyticsPostFor]); offline is [AnalyticsPost.Retry]. Anonymous; sends no token. */
  suspend fun postAnalytics(spaceId: String, body: String): AnalyticsPost =
      withContext(Dispatchers.IO) {
        val c =
            try {
              URL("$base/api/ar/spaces/${enc(spaceId)}/analytics").openConnection() as HttpURLConnection
            } catch (e: java.io.IOException) {
              return@withContext AnalyticsPost.Retry
            }
        try {
          c.requestMethod = "POST"
          c.connectTimeout = 15_000
          c.readTimeout = 15_000
          c.useCaches = false
          c.doOutput = true
          c.setRequestProperty("X-VLM-App-Version", userAgentVersion.toString())
          c.setRequestProperty("Content-Type", "application/json")
          c.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
          analyticsPostFor(c.responseCode)
        } catch (e: java.io.IOException) {
          AnalyticsPost.Retry
        } finally {
          c.disconnect()
        }
      }

  /** `POST /api/ar/pair`: [secretHash] is the hex SHA-256 of the headset's secret. The secret itself is never sent here. */
  suspend fun startPairing(secretHash: String, deviceName: String?): DeviceCall<PairStart> =
      device(
          "/api/ar/pair",
          buildJsonObject {
            put("secretHash", secretHash)
            if (deviceName != null) put("deviceName", deviceName)
          },
          ::parsePairStart,
      )

  /** `POST /api/ar/pair/:code/claim`: [DeviceCall.NotFound] is an expired code. */
  suspend fun claim(code: String, secret: String): DeviceCall<PairClaim> =
      device("/api/ar/pair/${enc(code)}/claim", secretBody(secret), ::parseClaim)

  /** `POST /api/ar/devices/:id/pass`: an AR pass for [spaceId]. */
  suspend fun mintPass(deviceId: String, secret: String, spaceId: String): DeviceCall<MintedPass> =
      device(
          "/api/ar/devices/${enc(deviceId)}/pass",
          buildJsonObject {
            put("secret", secret)
            put("spaceId", spaceId)
          },
          ::parsePass,
      )

  /** `POST /api/ar/devices/:id/end` (204). */
  suspend fun endSession(deviceId: String, secret: String): DeviceCall<Unit> =
      device("/api/ar/devices/${enc(deviceId)}/end", secretBody(secret)) { Unit }

  /** `POST /api/ar/devices/:id/spaces`: the spaces the approver can build on. */
  suspend fun deviceSpaces(deviceId: String, secret: String): DeviceCall<List<DeviceSpace>> =
      device("/api/ar/devices/${enc(deviceId)}/spaces", secretBody(secret), ::parseDeviceSpaces)

  private fun secretBody(secret: String) = buildJsonObject { put("secret", secret) }

  private suspend fun <T> device(path: String, body: JsonObject, parse: (String) -> T?): DeviceCall<T> =
      withContext(Dispatchers.IO) {
        val c =
            try {
              URL(base + path).openConnection() as HttpURLConnection
            } catch (e: java.io.IOException) {
              return@withContext DeviceCall.Offline
            }
        try {
          c.requestMethod = "POST"
          c.connectTimeout = 15_000
          c.readTimeout = 15_000
          c.useCaches = false
          c.doOutput = true
          c.setRequestProperty("X-VLM-App-Version", userAgentVersion.toString())
          c.setRequestProperty("Content-Type", "application/json")
          c.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
          val status = c.responseCode
          val text =
              (if (status in 200..299) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
          when {
            status in 200..299 -> parse(text)?.let { DeviceCall.Ok(it) } ?: DeviceCall.Failed(status)
            status == 401 ->
                when (errorCode(text)) {
                  "bad_secret" -> DeviceCall.BadSecret
                  "device_revoked" -> DeviceCall.Revoked
                  else -> DeviceCall.Unauthorized
                }
            status == 403 -> DeviceCall.NoAccess
            status == 404 -> DeviceCall.NotFound
            status == 429 -> DeviceCall.RateLimited
            else -> DeviceCall.Failed(status)
          }
        } catch (e: java.io.IOException) {
          DeviceCall.Offline
        } finally {
          c.disconnect()
        }
      }

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
