package gg.vlm.spaces.ring

import kotlin.math.hypot

/**
 * Turns per-frame ring detections into trusted ones: an ID counts only if it is [registered], its
 * format version is in [SUPPORTED_VERSIONS], and it was detected in [framesToAgree] frames in a row. A frame that misses an ID resets its count, so one bad
 * decode never shows up as a marker. Not thread-safe; call [update] from the camera thread only.
 */
class RingTracker(private val registered: Set<Long>, private val framesToAgree: Int = 3) {
  private val streak = HashMap<Long, Int>()

  /** Feeds one frame's detections; returns the registered ones seen in the last [framesToAgree] frames. */
  fun update(detections: List<RingDetection>): List<RingDetection> {
    val seen =
        detections
            .filter { it.version in SUPPORTED_VERSIONS && it.id in registered }
            .distinctBy { it.id }
    val ids = seen.mapTo(HashSet()) { it.id }
    streak.keys.retainAll(ids)
    for (id in ids) streak[id] = (streak[id] ?: 0) + 1
    return seen.filter { streak.getValue(it.id) >= framesToAgree }
  }

  /** Forgets every streak, as at a new camera run, so frames before a gap never count toward agreement. */
  fun reset() {
    streak.clear()
  }

  companion object {
    /** Marker format versions this app reads; a marker of any other version is someone else's layout. */
    val SUPPORTED_VERSIONS = setOf(0)
  }
}

/** The detection whose centre is nearest the middle of a [width] x [height] image, or null if there are none. */
fun nearestToCentre(detections: List<RingDetection>, width: Int, height: Int): RingDetection? =
    detections.minByOrNull { hypot(it.cx - width / 2.0, it.cy - height / 2.0) }
