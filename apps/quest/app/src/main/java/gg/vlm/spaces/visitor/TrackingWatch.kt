package gg.vlm.spaces.visitor

import gg.vlm.spaces.Vec3
import gg.vlm.spaces.space.angleDiffDeg
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/**
 * Spots the headset's tracking jumping (a relocalization): a head move faster than a person moves. A stalled tick
 * (the main thread busy for a moment while walking) allows for the time that passed, up to [VisitorTuning.MAX_TICK_GAP_S]:
 * past that, a move still has to beat what that much time allows to count as a jump.
 */
class TrackingWatch {
  private var last: Vec3? = null
  private var lastYaw = 0.0

  /** True when the head moved or turned too far for the [dtS] seconds since the previous call. */
  fun onHead(position: Vec3, yawDeg: Double, dtS: Double): Boolean {
    val p = last
    val dt = min(max(dtS, 0.0), VisitorTuning.MAX_TICK_GAP_S)
    val maxMove = max(VisitorTuning.JUMP_DISTANCE_M, VisitorTuning.MAX_WALK_SPEED_M_S * dt)
    val maxTurn = max(VisitorTuning.JUMP_YAW_DEG, VisitorTuning.MAX_TURN_DEG_S * dt)
    val jumped = p != null && (dist(p, position) > maxMove || abs(angleDiffDeg(yawDeg, lastYaw)) > maxTurn)
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
