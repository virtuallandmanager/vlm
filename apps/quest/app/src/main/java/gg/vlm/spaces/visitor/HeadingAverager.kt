package gg.vlm.spaces.visitor

import gg.vlm.spaces.space.angleDiffDeg
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.sin

/**
 * The last [capacity] per-frame wall headings of one ring (degrees, as `wallHeading` gives them), kept beside its
 * `PoseAverager`. Headings are averaged on the circle, so 179° and −179° average to 180°. A frame with no wall
 * (null) anywhere in the window means there is no heading: heading comes from the wall the ring is on.
 */
class HeadingAverager(private val capacity: Int = 15) {
  private val samples = ArrayDeque<Double?>()

  fun add(headingDeg: Double?) {
    if (samples.size == capacity) samples.removeFirst()
    samples.addLast(headingDeg)
  }

  fun clear() {
    samples.clear()
  }

  /** The circular mean in (−180, 180], or null when empty or when a frame in the window had no wall. */
  fun mean(): Double? {
    val hs = complete() ?: return null
    val s = hs.sumOf { sin(Math.toRadians(it)) }
    val c = hs.sumOf { cos(Math.toRadians(it)) }
    val deg = Math.toDegrees(atan2(s, c))
    return if (deg <= -180.0) deg + 360.0 else deg
  }

  /** The largest angle between a heading and the [mean], in degrees, or null as for [mean]. */
  fun spread(): Double? {
    val m = mean() ?: return null
    return complete()!!.maxOf { abs(angleDiffDeg(it, m)) }
  }

  private fun complete(): List<Double>? =
      if (samples.isEmpty() || samples.any { it == null }) null else samples.map { it!! }
}
