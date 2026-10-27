package io.virvi.ar.ring

import kotlin.math.hypot

/**
 * Turns per-frame ring detections into trusted ones: an ID counts only if it is [registered] (any ID while that is
 * null), its format version is in [SUPPORTED_VERSIONS], and it was detected in [framesToAgree] frames in a row. A frame
 * that misses an ID resets its count, so one bad decode never shows up as a marker. Call [update] from the camera
 * thread only; [registered] may be set from any thread.
 */
class RingTracker(registered: Set<Long>?, private val framesToAgree: Int = 3) {
  @Volatile var registered: Set<Long>? = registered
  private val streak = HashMap<Long, Int>()

  /** Feeds one frame's detections; returns the registered ones seen in the last [framesToAgree] frames. */
  fun update(detections: List<RingDetection>): List<RingDetection> {
    val accept = registered
    val seen =
        detections
            .filter { it.version in SUPPORTED_VERSIONS && (accept == null || it.id in accept) }
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
