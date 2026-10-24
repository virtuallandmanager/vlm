package gg.vlm.spaces.builder

import gg.vlm.spaces.Vec3
import gg.vlm.spaces.api.BuilderCall
import gg.vlm.spaces.api.MarkerPose
import gg.vlm.spaces.ring.WALL_TOLERANCE_M
import gg.vlm.spaces.ring.WallPlane
import gg.vlm.spaces.space.RootPose
import gg.vlm.spaces.space.markerInScene
import gg.vlm.spaces.space.rootFromMarker
import gg.vlm.spaces.space.rotateY
import gg.vlm.spaces.visitor.VisitorTuning
import java.util.Locale
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

/** Where the scene starts on a floor's first visit: the ring at the middle of its north wall, facing into the scene. */
private const val DEFAULT_RING_X = 8.0

/** A printed ring's size is checked to this (the share it is off, 1/ratio − 1). */
private const val SIZE_TOLERANCE = 0.03

/**
 * The first visit's starting spot: the ring seen at [markerWorld] facing [headingWorldDeg] is at scene point
 * `(8, floorHeightM + markerHeightAboveFloorM, 0)` facing +Z (the scene's north wall centre, facing in).
 */
fun defaultRoot(markerWorld: Vec3, headingWorldDeg: Double, floorHeightM: Double, markerHeightAboveFloorM: Double): RootPose =
    rootFromMarker(markerWorld, headingWorldDeg, MarkerPose(DEFAULT_RING_X, floorHeightM + markerHeightAboveFloorM, 0.0, 0.0))

/**
 * [root] moved by ([dx], [dz]) in world metres and turned [dYawDeg] about the world point [pivot] (the ring), so the
 * ring keeps its scene position and only its scene heading changes, by −[dYawDeg].
 */
fun nudge(root: RootPose, dx: Double, dz: Double, dYawDeg: Double, pivot: Vec3): RootPose {
  val d = Vec3(root.position.x - pivot.x, root.position.y - pivot.y, root.position.z - pivot.z)
  val r = rotateY(dYawDeg, d)
  return RootPose(Vec3(pivot.x + r.x + dx, root.position.y, pivot.z + r.z + dz), root.yawDeg + dYawDeg)
}

/**
 * The ellipse range (from the recorded diameter) over the depth range (from the room scan). A print scaled by `s`
 * reads `1/s` as far by its size, so a ratio above 1 means the print is smaller than recorded.
 */
fun sizeRatio(rangeFromEllipseM: Double, rangeFromDepthM: Double): Double = rangeFromEllipseM / rangeFromDepthM

/** The printed-size copy for [ratio] (see [sizeRatio]), or null when it is within 3% or not a usable number. */
fun sizeWarning(ratio: Double): String? {
  if (!ratio.isFinite() || ratio <= 0.0) return null
  val off = abs(1.0 / ratio - 1.0)
  if (off <= SIZE_TOLERANCE) return null
  val n = (off * 100).roundToInt()
  val how = if (ratio > 1.0) "smaller" else "larger"
  return "This ring looks about $n% $how than its recorded size: was it printed at 100%?"
}

/**
 * The distance along the ray from [origin] in the unit direction [dir] to the plane through [planePoint] with normal
 * [planeNormal], or null when the ray is parallel to it or the plane is behind.
 */
fun rangeToPlane(origin: Vec3, dir: Vec3, planePoint: Vec3, planeNormal: Vec3): Double? {
  val denom = dir.x * planeNormal.x + dir.y * planeNormal.y + dir.z * planeNormal.z
  if (abs(denom) < 1e-6) return null
  val t =
      ((planePoint.x - origin.x) * planeNormal.x + (planePoint.y - origin.y) * planeNormal.y +
          (planePoint.z - origin.z) * planeNormal.z) / denom
  return t.takeIf { it > 0.0 }
}

/**
 * The depth range for the printed-size check: from [origin] (the camera) along the ray through [ring] to the plane of
 * the scanned wall the ring is on (the wall nearest it within [WALL_TOLERANCE_M] of its plane and edges), or null when
 * there is no such wall.
 */
fun depthRange(origin: Vec3, ring: Vec3, walls: List<WallPlane>): Double? {
  val wall =
      walls
          .mapNotNull { w ->
            val len = hypot(w.normal.x.toDouble(), w.normal.z.toDouble())
            if (len < 1e-3) return@mapNotNull null
            val nx = w.normal.x / len
            val nz = w.normal.z / len
            val dx = ring.x - w.centre.x
            val dy = ring.y - w.centre.y
            val dz = ring.z - w.centre.z
            val gap = abs(dx * nx + dz * nz)
            val along = abs(dx * nz - dz * nx)
            if (gap > WALL_TOLERANCE_M || along > w.halfWidth + WALL_TOLERANCE_M || abs(dy) > w.halfHeight + WALL_TOLERANCE_M) null
            else Triple(gap, w, Vec3(nx, 0.0, nz))
          }
          .minByOrNull { it.first } ?: return null
  val dx = ring.x - origin.x
  val dy = ring.y - origin.y
  val dz = ring.z - origin.z
  val len = sqrt(dx * dx + dy * dy + dz * dz)
  if (len < 1e-6) return null
  val c = wall.second.centre
  return rangeToPlane(origin, Vec3(dx / len, dy / len, dz / len), Vec3(c.x.toDouble(), c.y.toDouble(), c.z.toDouble()), wall.third)
}

/** One thumbstick reading's worth of change: world metres and degrees of turn (see [stickNudge]). */
data class StickNudge(val dx: Double, val dz: Double, val dYawDeg: Double)

private const val STICK_DEADZONE = 0.5
private const val FINE_STEP_M = 0.01
private const val FINE_STEP_DEG = 0.5
/** Without the grip a step is this many times the fine one. */
private const val COARSE_FACTOR = 5.0

/**
 * One step from the sticks: the left stick ([leftX] right, [leftY] forward) moves the scene in the direction the
 * head faces ([headHeadingDeg], from +Z toward +X), the right stick's [rightX] turns it. Each axis past the dead zone
 * is one step: 1 cm and 0.5° with the grip held ([fine]), five times that without.
 */
fun stickNudge(leftX: Double, leftY: Double, rightX: Double, headHeadingDeg: Double, fine: Boolean): StickNudge {
  val k = if (fine) 1.0 else COARSE_FACTOR
  val side = if (abs(leftX) > STICK_DEADZONE) Math.signum(leftX) else 0.0
  val fwd = if (abs(leftY) > STICK_DEADZONE) Math.signum(leftY) else 0.0
  val turn = if (abs(rightX) > STICK_DEADZONE) Math.signum(rightX) else 0.0
  val h = Math.toRadians(headHeadingDeg)
  // Forward is (sin h, cos h) on (x, z); right is (cos h, −sin h).
  return StickNudge(
      dx = (fwd * sin(h) + side * cos(h)) * FINE_STEP_M * k,
      dz = (fwd * cos(h) - side * sin(h)) * FINE_STEP_M * k,
      dYawDeg = turn * FINE_STEP_DEG * k,
  )
}

/** A steady ring as the align flow sees it: its averaged world position and wall heading, and its distance from the head. */
data class RingSight(val world: Vec3, val headingDeg: Double, val distanceM: Double)

/** What the builder sends to save an alignment. */
data class AlignSave(val pose: MarkerPose, val heightAboveFloorM: Double)

sealed interface AlignState {
  /** Waiting for the ring to be steady and within reach. */
  data object LookAtRing : AlignState
  /** The scene is up at [root] for the builder to adjust. */
  data class Placed(val root: RootPose) : AlignState
  data object Saving : AlignState
  /** Saved; [warnings] are the server's codes (see [AlignFlow.warningLines]). */
  data class Saved(val warnings: List<String>) : AlignState
  /** The last step was refused ([reason] is copy); the scene, if placed, can still be adjusted and saved. */
  data class Refused(val reason: String) : AlignState
}

/**
 * The align journey for one floor's ring, with no view or I/O: the caller feeds it the ring's steady sights, the sticks
 * and the save answer, and shows [state]. The height above the floor is the ring's world `y`, since the app runs in
 * LOCAL_FLOOR space. Main thread only.
 */
class AlignFlow(private val floorName: String, private val floorHeightM: Double) {
  var state: AlignState = AlignState.LookAtRing
    private set

  /** The printed-size warning, once [checkSize] has found one. */
  var sizeMessage: String? = null
    private set

  private var ring: RingSight? = null
  private var root: RootPose? = null
  private var sizeChecked = false

  /** A steady sight of the ring: the first one within reach places the scene at [defaultRoot]; later ones are ignored. */
  fun onSteadyRing(sight: RingSight) {
    if (state != AlignState.LookAtRing || sight.distanceM > VisitorTuning.MAX_LOCK_DISTANCE_M) return
    ring = sight
    val r = defaultRoot(sight.world, sight.headingDeg, floorHeightM, sight.world.y)
    root = r
    state = AlignState.Placed(r)
  }

  /** Moves and turns the scene about the ring (see [nudge]); does nothing before the scene is placed or while saving. */
  fun nudge(dx: Double, dz: Double, dYawDeg: Double) {
    val r = ring ?: return
    val cur = root ?: return
    if (state is AlignState.Saving || state is AlignState.Saved) return
    val next = nudge(cur, dx, dz, dYawDeg, r.world)
    root = next
    state = AlignState.Placed(next)
  }

  /**
   * Starts a save from [distanceM] away: the pose to send, or null when the scene isn't placed or the builder is
   * beyond [VisitorTuning.MAX_LOCK_DISTANCE_M] (then [state] is Refused with "Step closer to the ring to save").
   */
  fun requestSave(distanceM: Double): AlignSave? {
    val r = ring ?: return null
    val cur = root ?: return null
    if (state is AlignState.Saving || state is AlignState.Saved) return null
    if (distanceM > VisitorTuning.MAX_LOCK_DISTANCE_M) {
      state = AlignState.Refused(STEP_CLOSER)
      return null
    }
    state = AlignState.Saving
    return AlignSave(markerInScene(cur, r.world, r.headingDeg), r.world.y)
  }

  /** The answer to the save [requestSave] started. */
  fun saved(result: BuilderCall<List<String>>) {
    state =
        when (result) {
          is BuilderCall.Ok -> AlignState.Saved(result.value)
          BuilderCall.NoAccess -> AlignState.Refused("This account can't edit this scene")
          BuilderCall.Offline -> AlignState.Refused("Can't reach vlm.gg: check the connection and save again")
          else -> AlignState.Refused("Couldn't save the alignment: try again")
        }
  }

  /**
   * The printed-size check, once per alignment: [rangeFromEllipseM] over [rangeFromDepthM] (null when the room scan
   * has no wall behind the ring, which leaves the check for a later try).
   */
  fun checkSize(rangeFromEllipseM: Double, rangeFromDepthM: Double?) {
    if (sizeChecked || rangeFromDepthM == null || rangeFromDepthM <= 0.0) return
    sizeChecked = true
    sizeMessage = sizeWarning(sizeRatio(rangeFromEllipseM, rangeFromDepthM))
  }

  /** The copy for the saved warnings this app knows; others are not shown. */
  fun warningLines(): List<String> =
      (state as? AlignState.Saved)?.warnings.orEmpty().mapNotNull {
        if (it == FLOOR_HEIGHT_OFF) "Floor height doesn't match $floorName (${metres(floorHeightM)} m): check the floor" else null
      }

  private fun metres(h: Double) = String.format(Locale.ROOT, "%.2f", h).trimEnd('0').trimEnd('.')

  companion object {
    const val STEP_CLOSER = "Step closer to the ring to save"
    private const val FLOOR_HEIGHT_OFF = "floor_height_off"
  }
}
