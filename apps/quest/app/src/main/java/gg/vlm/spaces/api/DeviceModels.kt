package gg.vlm.spaces.api

import java.time.Instant
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject

// The wire shapes of packages/vlm-shared/src/ar.ts for headset pairing (ArPairStartResponse, ArPairClaimResponse,
// ArPassResponse, ArDeviceSpace).

enum class DeviceKind { PERSONAL, SHARED }

data class PairStart(val code: String, val approveUrl: String, val codeExpiresAtMs: Long) {
  /** The code is a credential: it is not printed. */
  override fun toString() = "PairStart(codeExpiresAtMs=$codeExpiresAtMs)"
}

sealed interface PairClaim {
  data object Pending : PairClaim
  data class Approved(val deviceId: String, val kind: DeviceKind, val expiresAtMs: Long) : PairClaim
  data object Refused : PairClaim
}

data class MintedPass(val pass: String, val expiresAtMs: Long, val sceneId: String) {
  /** The pass is a credential: it is not printed. */
  override fun toString() = "MintedPass(expiresAtMs=$expiresAtMs, sceneId=$sceneId)"
}

data class DeviceMarker(val markerId: String, val floorId: String, val code: String)

data class DeviceSpace(
    val spaceId: String,
    val spaceName: String,
    val sceneId: String,
    val sceneName: String,
    val markers: List<DeviceMarker>,
)

private fun JsonObject.str(k: String): String? = (this[k] as? JsonPrimitive)?.takeIf { it.isString }?.content

private fun obj(body: String): JsonObject? = runCatching { Json.parseToJsonElement(body).jsonObject }.getOrNull()

private fun instantMs(s: String?): Long? = s?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() }

/** The `error` code of a failure body, or null. */
fun errorCode(body: String): String? = obj(body)?.str("error")

fun parsePairStart(body: String): PairStart? {
  val o = obj(body) ?: return null
  return PairStart(
      o.str("code") ?: return null,
      o.str("approveUrl") ?: return null,
      instantMs(o.str("codeExpiresAt")) ?: return null,
  )
}

fun parseClaim(body: String): PairClaim? {
  val o = obj(body) ?: return null
  return when (o.str("status")) {
    "pending" -> PairClaim.Pending
    "refused" -> PairClaim.Refused
    "approved" ->
        PairClaim.Approved(
            o.str("deviceId") ?: return null,
            when (o.str("kind")) {
              "personal" -> DeviceKind.PERSONAL
              "shared" -> DeviceKind.SHARED
              else -> return null
            },
            instantMs(o.str("expiresAt")) ?: return null,
        )
    else -> null
  }
}

fun parsePass(body: String): MintedPass? {
  val o = obj(body) ?: return null
  return MintedPass(
      o.str("pass") ?: return null,
      instantMs(o.str("passExpiresAt")) ?: return null,
      o.str("sceneId") ?: return null,
  )
}

fun parseDeviceSpaces(body: String): List<DeviceSpace>? {
  val arr = runCatching { Json.parseToJsonElement(body) as? JsonArray }.getOrNull() ?: return null
  return arr.map { e ->
    val o = e as? JsonObject ?: return null
    val markers =
        (o["markers"] as? JsonArray)?.map { m ->
          val mo = m as? JsonObject ?: return null
          DeviceMarker(mo.str("markerId") ?: return null, mo.str("floorId") ?: return null, mo.str("code") ?: return null)
        } ?: return null
    DeviceSpace(
        o.str("spaceId") ?: return null,
        o.str("spaceName") ?: return null,
        o.str("sceneId") ?: return null,
        o.str("sceneName") ?: return null,
        markers,
    )
  }
}
