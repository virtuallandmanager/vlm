package gg.vlm.spaces

/**
 * What the detection-range test records for one ring test marker (RING_TEST_MARKERS): where tracking started ("found") and where it stopped
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
