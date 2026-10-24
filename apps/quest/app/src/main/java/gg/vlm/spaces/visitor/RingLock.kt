package gg.vlm.spaces.visitor

import gg.vlm.spaces.Vec3
import gg.vlm.spaces.ring.PoseAverager
import kotlin.math.sqrt

/** One frame's verdict on a ring: its [gate], whether it has just become STEADY, and its averaged pose. */
data class LockStep(val gate: Gate, val becameSteady: Boolean, val world: Vec3, val headingDeg: Double?)

/**
 * One ring in view: its averaged world position and wall heading, put through [LockGate] each camera frame. Heading
 * comes from the wall the ring is on, so with no wall heading in the window the ring is GATHERING, never TOO_FAR or
 * STEADY. [LockStep.becameSteady] marks a new steady pose (the gate has just become STEADY). Main thread only.
 */
class RingLock(capacity: Int = VisitorTuning.AVERAGE_FRAMES, minFrames: Int = VisitorTuning.MIN_FRAMES) {
  private val positions = PoseAverager(capacity, minFrames)
  private val headings = HeadingAverager(capacity)
  private var steady = false

  fun step(world: Vec3, headingDeg: Double?, head: Vec3): LockStep {
    positions.add(world)
    headings.add(headingDeg)
    val mean = positions.mean()!!
    val heading = headings.mean()
    val gate =
        if (heading == null) Gate.GATHERING
        else {
          val dx = mean.x - head.x
          val dy = mean.y - head.y
          val dz = mean.z - head.z
          LockGate.evaluate(positions.count, positions.spread()!!, headings.spread()!!, sqrt(dx * dx + dy * dy + dz * dz))
        }
    val now = gate == Gate.STEADY
    val edge = now && !steady
    steady = now
    return LockStep(gate, edge, mean, heading)
  }

  fun clear() {
    positions.clear()
    headings.clear()
    steady = false
  }
}
