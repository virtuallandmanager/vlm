package gg.vlm.spaces.visitor

import gg.vlm.spaces.Vec3
import gg.vlm.spaces.ring.PoseAverager
import gg.vlm.spaces.ring.WallFix
import kotlin.math.sqrt

/**
 * One frame's verdict on a ring: its [gate], whether it has just become STEADY, its averaged pose, whether its
 * position has held still for over [VisitorTuning.NO_WALL_HINT_MS] with no wall heading ([wallMissing]), its
 * averaged position's distance from the head ([distanceM]), and whether it holds still with its wall found but seen
 * too far from head-on to count ([tooSteep]).
 */
data class LockStep(
    val gate: Gate,
    val becameSteady: Boolean,
    val world: Vec3,
    val headingDeg: Double?,
    val wallMissing: Boolean = false,
    val distanceM: Double = 0.0,
    val tooSteep: Boolean = false,
)

/**
 * Whether [fix] was seen too far from head-on (over [VisitorTuning.MAX_VIEW_ANGLE_DEG]) for its heading to count:
 * near 45° one circle can't tell its own wall from a perpendicular one.
 */
fun isTooSteep(fix: WallFix?): Boolean = fix != null && fix.viewAngleDeg > VisitorTuning.MAX_VIEW_ANGLE_DEG

/**
 * One ring in view: its averaged world position and wall heading, put through [LockGate] each camera frame. Heading
 * comes from the wall the ring is on, so with no wall heading in the window the ring is GATHERING, never TOO_FAR or
 * STEADY (its [LockStep.distanceM] still tells [gatherStatus] it is too far). [LockStep.becameSteady] marks a new steady pose (the gate has just become STEADY). Main thread only.
 */
class RingLock(capacity: Int = VisitorTuning.AVERAGE_FRAMES, private val minFrames: Int = VisitorTuning.MIN_FRAMES) {
  private val positions = PoseAverager(capacity, minFrames)
  private val headings = HeadingAverager(capacity)
  private var steady = false
  /** Since when the position has held still with no wall heading, or null. */
  private var noWallSince: Long? = null

  /** [steep]: this frame found the ring's wall but too far from head-on, so [headingDeg] is null (see [isTooSteep]). */
  fun step(world: Vec3, headingDeg: Double?, head: Vec3, nowMs: Long, steep: Boolean = false): LockStep {
    positions.add(world)
    headings.add(headingDeg)
    val mean = positions.mean()!!
    val heading = headings.mean()
    val dx = mean.x - head.x
    val dy = mean.y - head.y
    val dz = mean.z - head.z
    val distance = sqrt(dx * dx + dy * dy + dz * dz)
    val gate =
        if (heading == null) Gate.GATHERING
        else LockGate.evaluate(positions.count, positions.spread()!!, headings.spread()!!, distance)
    val now = gate == Gate.STEADY
    val edge = now && !steady
    steady = now
    val still = heading == null && positions.count >= minFrames && positions.spread()!! <= VisitorTuning.MAX_SPREAD_M
    // Seen too steeply the wall is there: the visitor is told where to stand, not that the wall is missing.
    val stillWithoutWall = still && !steep
    if (!stillWithoutWall) noWallSince = null
    else if (noWallSince == null) noWallSince = nowMs
    val wallMissing = noWallSince?.let { nowMs - it > VisitorTuning.NO_WALL_HINT_MS } == true
    return LockStep(gate, edge, mean, heading, wallMissing, distance, still && steep)
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
  /** Every ring in view holds still with its wall found, but is seen too far from head-on to lock. */
  TOO_STEEP,
}

/**
 * The gather status for one camera frame: [steps] are the space's rings in view this frame, and [unreadableSeen]
 * says an unreadable ring is being seen. A ring with no wall heading never reaches the gate's TOO_FAR, so its distance
 * is checked here: stepping closer comes before finding the wall.
 */
fun gatherStatus(steps: List<LockStep>, unreadableSeen: Boolean): GatherStatus =
    when {
      steps.isEmpty() -> if (unreadableSeen) GatherStatus.UNREADABLE else GatherStatus.NONE_IN_VIEW
      steps.any { it.gate == Gate.STEADY } -> GatherStatus.GATHERING
      steps.any {
        it.gate == Gate.TOO_FAR || (it.headingDeg == null && it.distanceM > VisitorTuning.MAX_LOCK_DISTANCE_M)
      } -> GatherStatus.TOO_FAR
      steps.all { it.tooSteep } -> GatherStatus.TOO_STEEP
      steps.all { it.wallMissing } -> GatherStatus.NO_WALL
      else -> GatherStatus.GATHERING
    }
