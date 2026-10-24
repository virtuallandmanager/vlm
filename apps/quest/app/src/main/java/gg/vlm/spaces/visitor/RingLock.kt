package gg.vlm.spaces.visitor

import gg.vlm.spaces.Vec3
import gg.vlm.spaces.ring.PoseAverager
import kotlin.math.sqrt

/**
 * One frame's verdict on a ring: its [gate], whether it has just become STEADY, its averaged pose, and whether its
 * position has held still for over [VisitorTuning.NO_WALL_HINT_MS] with no wall heading ([wallMissing]).
 */
data class LockStep(
    val gate: Gate,
    val becameSteady: Boolean,
    val world: Vec3,
    val headingDeg: Double?,
    val wallMissing: Boolean = false,
)

/**
 * One ring in view: its averaged world position and wall heading, put through [LockGate] each camera frame. Heading
 * comes from the wall the ring is on, so with no wall heading in the window the ring is GATHERING, never TOO_FAR or
 * STEADY. [LockStep.becameSteady] marks a new steady pose (the gate has just become STEADY). Main thread only.
 */
class RingLock(capacity: Int = VisitorTuning.AVERAGE_FRAMES, private val minFrames: Int = VisitorTuning.MIN_FRAMES) {
  private val positions = PoseAverager(capacity, minFrames)
  private val headings = HeadingAverager(capacity)
  private var steady = false
  /** Since when the position has held still with no wall heading, or null. */
  private var noWallSince: Long? = null

  fun step(world: Vec3, headingDeg: Double?, head: Vec3, nowMs: Long): LockStep {
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
    val stillWithoutWall =
        heading == null && positions.count >= minFrames && positions.spread()!! <= VisitorTuning.MAX_SPREAD_M
    if (!stillWithoutWall) noWallSince = null
    else if (noWallSince == null) noWallSince = nowMs
    val wallMissing = noWallSince?.let { nowMs - it > VisitorTuning.NO_WALL_HINT_MS } == true
    return LockStep(gate, edge, mean, heading, wallMissing)
  }

  fun clear() {
    positions.clear()
    headings.clear()
    steady = false
    noWallSince = null
  }
}

/** How gathering a steady pose from the space's rings is going, for the hint while locking. */
enum class GatherStatus {
  /** None of the space's rings in view, and no unreadable ring either. */
  NONE_IN_VIEW,
  /** A ring of the space is in view and its pose is settling (or has settled). */
  GATHERING,
  /** The only rings in view are too far away to lock. */
  TOO_FAR,
  /** No ring of the space is readable, but a ring is seen that can't be read. */
  UNREADABLE,
  /** Every ring in view holds still but has had no wall heading for a while. */
  NO_WALL,
}

/**
 * The gather status for one camera frame: [steps] are the space's rings in view this frame, and [unreadableSeen]
 * says an unreadable ring is being seen.
 */
fun gatherStatus(steps: List<LockStep>, unreadableSeen: Boolean): GatherStatus =
    when {
      steps.isEmpty() -> if (unreadableSeen) GatherStatus.UNREADABLE else GatherStatus.NONE_IN_VIEW
      steps.any { it.gate == Gate.STEADY } -> GatherStatus.GATHERING
      steps.any { it.gate == Gate.TOO_FAR } -> GatherStatus.TOO_FAR
      steps.all { it.wallMissing } -> GatherStatus.NO_WALL
      else -> GatherStatus.GATHERING
    }
