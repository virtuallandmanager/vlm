package gg.vlm.spaces.quest.ring

/**
 * Turns per-frame ring detections into trusted ones: an ID counts only if it is [registered] and was
 * detected in [framesToAgree] frames in a row. A frame that misses an ID resets its count, so one bad
 * decode never shows up as a marker. Not thread-safe; call [update] from the camera thread only.
 */
class RingTracker(private val registered: Set<Long>, private val framesToAgree: Int = 3) {
  private val streak = HashMap<Long, Int>()

  /** Feeds one frame's detections; returns the registered ones seen in the last [framesToAgree] frames. */
  fun update(detections: List<RingDetection>): List<RingDetection> {
    val seen = detections.filter { it.id in registered }.distinctBy { it.id }
    val ids = seen.mapTo(HashSet()) { it.id }
    streak.keys.retainAll(ids)
    for (id in ids) streak[id] = (streak[id] ?: 0) + 1
    return seen.filter { streak.getValue(it.id) >= framesToAgree }
  }
}
