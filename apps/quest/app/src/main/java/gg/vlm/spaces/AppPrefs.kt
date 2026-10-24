package gg.vlm.spaces

import android.content.Context
import gg.vlm.spaces.visitor.RecentSpace
import gg.vlm.spaces.visitor.VisitorPrefs
import gg.vlm.spaces.visitor.decodeRecents
import gg.vlm.spaces.visitor.encodeRecents

const val DEFAULT_BASE_URL = "https://vlm.gg"

/** The server: always [DEFAULT_BASE_URL] in release; in debug builds an http(s) [extra], else the [saved] one. */
fun resolveBaseUrl(debug: Boolean, extra: String?, saved: String?): String {
  if (!debug) return DEFAULT_BASE_URL
  fun ok(u: String?) = u?.trim()?.takeIf { it.startsWith("http://") || it.startsWith("https://") }
  return ok(extra) ?: ok(saved) ?: DEFAULT_BASE_URL
}

/** The settings the app keeps on the headset. */
class AppPrefs(context: Context) : VisitorPrefs {
  private val prefs = context.getSharedPreferences("vlm-spaces", Context.MODE_PRIVATE)

  var occlusion: Occlusion
    get() = prefs.getString("occlusion", null)?.let { n -> Occlusion.entries.firstOrNull { it.name == n } } ?: Occlusion.DEPTH
    set(value) = prefs.edit().putString("occlusion", value.name).apply()

  /**
   * When true, taking the headset off hides the scene but keeps the space loaded; when false (the default) it ends the
   * visit, back at the hint card with nothing loaded. Builders turn it on (plan 3).
   */
  override var keepLoadedBetweenVisitors: Boolean
    get() = prefs.getBoolean("keepLoadedBetweenVisitors", false)
    set(value) = prefs.edit().putBoolean("keepLoadedBetweenVisitors", value).apply()

  /** Spaces opened or visited, newest first (see [remember]). */
  override var recentSpaces: List<RecentSpace>
    get() = decodeRecents(prefs.getString("recentSpaces", null))
    set(value) = prefs.edit().putString("recentSpaces", encodeRecents(value)).apply()

  /** The server for this launch (see [resolveBaseUrl]); a debug build saves a `baseUrl` intent extra for next time. */
  fun baseUrl(extra: String?): String {
    val url = resolveBaseUrl(BuildConfig.DEBUG, extra, prefs.getString("baseUrl", null))
    if (BuildConfig.DEBUG && extra != null && url == extra.trim()) prefs.edit().putString("baseUrl", url).apply()
    return url
  }
}
