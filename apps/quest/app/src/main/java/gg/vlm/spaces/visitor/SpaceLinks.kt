package gg.vlm.spaces.visitor

import android.content.Intent
import gg.vlm.spaces.ring.RingCodec
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull

private val SPACE_LINK = Regex("""^https://vlm\.gg/s/([^/?#]+)/?(?:[?#].*)?$""", RegexOption.IGNORE_CASE)

/**
 * The space code in a `https://vlm.gg/s/<code>` link (a trailing slash, query or fragment is fine), as the 7 upper-case
 * characters [RingCodec.codeOf] gives, or null for any other link or a code that isn't one.
 */
fun spaceCodeFromUri(uri: String): String? {
  val raw = SPACE_LINK.matchEntire(uri.trim())?.groupValues?.get(1) ?: return null
  return RingCodec.parseCode(raw)?.let(RingCodec::codeOf)
}

/**
 * The space code an intent with [action], [data] and [flags] asks to open: a VIEW of a space link. A VIEW relaunched
 * from Recents (Android hands back the intent that first started the task) opens nothing: it isn't a new request.
 */
fun spaceCodeFromIntent(action: String?, data: String?, flags: Int): String? {
  if (action != Intent.ACTION_VIEW) return null
  if (flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return null
  return data?.let(::spaceCodeFromUri)
}

/** A space the visitor opened or visited: its [code] (a ring's or a link's), its name, and when. */
data class RecentSpace(val code: String, val spaceName: String, val openedAtMs: Long)

const val MAX_RECENT_SPACES = 20

/** [list] with [item] first and any older entry for the same code dropped, keeping at most [max]. */
fun remember(list: List<RecentSpace>, item: RecentSpace, max: Int = MAX_RECENT_SPACES): List<RecentSpace> =
    (listOf(item) + list.filter { it.code != item.code }).take(max)

fun encodeRecents(list: List<RecentSpace>): String =
    JsonArray(
            list.map {
              JsonObject(
                  mapOf(
                      "code" to JsonPrimitive(it.code),
                      "spaceName" to JsonPrimitive(it.spaceName),
                      "openedAtMs" to JsonPrimitive(it.openedAtMs),
                  )
              )
            }
        )
        .toString()

/** What [encodeRecents] saved; anything unreadable (or null) gives no entries, and a bad entry is skipped. */
fun decodeRecents(json: String?): List<RecentSpace> {
  if (json == null) return emptyList()
  val arr = try { Json.parseToJsonElement(json) as? JsonArray } catch (e: Exception) { null } ?: return emptyList()
  return arr.mapNotNull { e ->
    val o = e as? JsonObject ?: return@mapNotNull null
    fun str(k: String) = (o[k] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
    RecentSpace(
        str("code") ?: return@mapNotNull null,
        str("spaceName") ?: return@mapNotNull null,
        (o["openedAtMs"] as? JsonPrimitive)?.longOrNull ?: return@mapNotNull null,
    )
  }
}

/** The space page's content: what a link or a Spaces pick opened. [spaceName] and [whereText] arrive with the lookup. */
data class SpacePageInfo(val code: String, val spaceName: String?, val whereText: String?)
