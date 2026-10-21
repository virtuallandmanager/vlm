package gg.vlm.spaces.quest

/** The printed test markers from apps/ar-spike/tools/make_markers.py. */
data class TestMarker(val code: String, val width: Double) {
  /**
   * The QR code's side in metres. Quest tracks the QR code itself, not the whole tracked square: the square is 33
   * modules across (a version 2 QR code is 25, plus a 2-module quiet zone and a 2-module ring on each side).
   */
  val qrSide: Double
    get() = width * 25 / 33

  companion object {
    val ALL = listOf(TestMarker("TEST12", 0.12), TestMarker("TEST17", 0.17))
    private const val PREFIX = "HTTPS://VLM.GG/S/"

    /** The marker code in a marker QR payload (`HTTPS://VLM.GG/S/<CODE>`), or null for any other text. */
    fun codeFromQr(payload: String): String? {
      val p = payload.trim().uppercase()
      if (!p.startsWith(PREFIX)) return null
      return p.removePrefix(PREFIX).ifEmpty { null }
    }
  }
}

/**
 * What the detection-range test records for one marker: where tracking started ("found") and where it stopped
 * ("lost"), as distances from the headset in metres. Walk away until it's lost, then walk back until it's found.
 */
class MarkerReading {
  var tracked = false
    private set
  var now: Double? = null
    private set
  val foundAt = mutableListOf<Double>()
  val lostAt = mutableListOf<Double>()
  var farthestTracked: Double? = null
    private set
  /** The QR side Quest measured, in metres, the last time it tracked the code. */
  var measuredSide: Double? = null

  val farthestFound: Double?
    get() = foundAt.maxOrNull()

  fun observe(isTracked: Boolean, distance: Double) {
    if (isTracked) {
      if (!tracked) foundAt.add(distance)
      farthestTracked = maxOf(farthestTracked ?: 0.0, distance)
      now = distance
    } else {
      if (tracked) now?.let { lostAt.add(it) }
      now = null
    }
    tracked = isTracked
  }

  val summary: String
    get() {
      val lastFound = foundAt.lastOrNull() ?: return "not seen yet"
      val m = { d: Double -> "%.2f m".format(java.util.Locale.US, d) }
      val parts = mutableListOf(now?.let { "tracking at ${m(it)}" } ?: "not tracking")
      parts.add("found at ${m(lastFound)} (farthest ${m(farthestFound ?: lastFound)})")
      lostAt.lastOrNull()?.let { parts.add("lost at ${m(it)}") }
      return parts.joinToString(" · ")
    }
}
