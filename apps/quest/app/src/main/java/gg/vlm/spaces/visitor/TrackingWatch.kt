package gg.vlm.spaces.visitor

import gg.vlm.spaces.Vec3
import gg.vlm.spaces.space.angleDiffDeg
import kotlin.math.abs
import kotlin.math.sqrt

/** Spots the headset's tracking jumping (a relocalization): a head move too big for one tick. */
class TrackingWatch {
  private var last: Vec3? = null
  private var lastYaw = 0.0

  /** True when the head moved or turned more than the tuning limits since the previous call. */
  fun onHead(position: Vec3, yawDeg: Double): Boolean {
    val p = last
    val jumped =
        p != null &&
            (dist(p, position) > VisitorTuning.JUMP_DISTANCE_M ||
                abs(angleDiffDeg(yawDeg, lastYaw)) > VisitorTuning.JUMP_YAW_DEG)
    last = position
    lastYaw = yawDeg
    return jumped
  }

  fun reset() {
    last = null
  }

  private fun dist(a: Vec3, b: Vec3): Double {
    val dx = a.x - b.x
    val dy = a.y - b.y
    val dz = a.z - b.z
    return sqrt(dx * dx + dy * dy + dz * dz)
  }
}
