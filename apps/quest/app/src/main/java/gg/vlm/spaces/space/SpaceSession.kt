package gg.vlm.spaces.space

import android.util.Log
import com.meta.spatial.core.Pose
import com.meta.spatial.core.Vector3
import gg.vlm.spaces.RenderItem
import gg.vlm.spaces.Vec3
import gg.vlm.spaces.api.ArFeedSnapshot
import gg.vlm.spaces.api.FeedStatus
import gg.vlm.spaces.planScene
import gg.vlm.spaces.ring.CameraIntrinsics
import gg.vlm.spaces.ring.RingDetection
import gg.vlm.spaces.ring.WallPlane
import gg.vlm.spaces.ring.cameraToWorld
import gg.vlm.spaces.ring.circleNormals
import gg.vlm.spaces.ring.markerInCamera
import gg.vlm.spaces.ring.wallFix
import gg.vlm.spaces.visitor.Gate
import gg.vlm.spaces.visitor.LockStep
import gg.vlm.spaces.visitor.RingLock
import gg.vlm.spaces.visitor.isTooSteep

/** Draws a space's scene (the headset's `SceneRenderer`; a fake in tests). */
interface SceneView {
  fun apply(next: List<RenderItem>)

  fun setRoot(pose: RootPose)

  fun setVisible(on: Boolean, nowMs: Long)

  fun hideNow()

  fun clear()

  fun tick(nowMs: Long)

  fun count(): Int
}

/** Follows one space's feed (`ArFeed`; a fake in tests). */
interface SpaceFeed {
  fun start(spaceId: String, token: (() -> String?)? = null)

  fun stop()
}

/** The outline flashed on a ring when the scene locks on (`RingOutline`; a fake in tests). */
interface OutlineView {
  fun flash(world: Vec3, headingDeg: Double, diameterM: Double, nowMs: Long)

  fun tick(nowMs: Long)

  fun clear()
}

/** A ring's averaged world position and wall heading, on a frame its lock was STEADY. */
data class SteadyPose(val world: Vec3, val headingDeg: Double)

/**
 * One space on the headset, whoever is looking at it (visitor or builder): its feed and latest snapshot, its scene
 * (root, items, fade), the lock tracks of its rings in view, the ring outline, and where the scene is placed. It knows
 * nothing of the visitor's journey: the caller decides when to place, show and hide. [feed] builds the feed from the
 * session's own status and snapshot callbacks. Main thread only.
 */
class SpaceSession(
    private val view: SceneView,
    feed: (onStatus: (FeedStatus) -> Unit, onSnapshot: (ArFeedSnapshot) -> Unit) -> SpaceFeed,
    private val outline: OutlineView,
    private val clock: () -> Long,
) {
  /** A new snapshot of the running space, after its scene has been applied. */
  var onSnapshot: ((ArFeedSnapshot) -> Unit)? = null
  var onStatus: ((FeedStatus) -> Unit)? = null
  /** A ring of the space has just become steady (see [RingLock]). */
  var onSteady: ((ringId: Long, world: Vec3, headingDeg: Double) -> Unit)? = null

  private val feed = feed({ s -> onStatus?.invoke(s) }, ::snapshotArrived)

  /** The space whose feed is running, or null. */
  var spaceId: String? = null
    private set

  private var snapshot: ArFeedSnapshot? = null
  private var root: RootPose? = null
  /** The space's rings in view, and each one's step on the newest frame. */
  private val tracks = HashMap<Long, RingLock>()
  private val lastSteps = HashMap<Long, LockStep>()
  /** Where each ring last became steady, for its outline. */
  private val lockedAt = HashMap<Long, SteadyPose>()

  /** Follows [spaceId]'s feed, sending [token]'s answer (if any) with each request. */
  fun start(spaceId: String, token: (() -> String?)? = null) {
    this.spaceId = spaceId
    snapshot = null
    feed.start(spaceId, token)
  }

  /** Stops the feed and drops the space: its snapshot, rings, outline, placement and scene (video players included). */
  fun stop() {
    feed.stop()
    spaceId = null
    snapshot = null
    root = null
    resetLocks()
    lockedAt.clear()
    outline.clear()
    view.clear()
  }

  /** The running space's latest snapshot, or null before its first. */
  fun snapshot(): ArFeedSnapshot? = snapshot

  /** An exception in here would end the feed's loop silently, so it's caught and logged. */
  private fun snapshotArrived(s: ArFeedSnapshot) {
    try {
      if (s.space.id != spaceId) return
      snapshot = s
      view.apply(planScene(s.scene))
      onSnapshot?.invoke(s)
    } catch (e: Exception) {
      Log.e(TAG, "Snapshot ${s.version} failed", e)
    }
  }

  /**
   * One camera frame's trusted rings, with the head pose, the camera's intrinsics and the room's walls: steps the lock
   * of each of the space's rings in view (others are ignored) and returns their steps. A ring that has just become
   * steady is reported to [onSteady] as it is stepped.
   */
  fun onRings(tracked: List<RingDetection>, head: Pose, k: CameraIntrinsics?, walls: List<WallPlane>): List<LockStep> {
    val now = clock()
    val seen = tracked.associateBy { it.id }
    tracks.keys.retainAll(seen.keys)
    lastSteps.keys.retainAll(seen.keys)
    val space = snapshot?.space
    val steps = ArrayList<LockStep>()
    for ((id, d) in seen) {
      val marker = space?.markerByRing(id)?.second ?: continue
      if (k == null) continue
      val w = cameraToWorld(markerInCamera(d, k, marker.diameterMm / 1000.0), head, k)
      val fix = wallFix(w, walls, head.t, circleNormals(d, k, head))
      val steep = isTooSteep(fix) // an ambiguous corner seen steeply is also told where to stand
      val step =
          tracks.getOrPut(id) { RingLock() }.step(w.vec(), fix?.headingDeg?.takeUnless { steep }, head.t.vec(), now, steep)
      steps += step
      lastSteps[id] = step
      if (step.becameSteady) {
        lockedAt[id] = SteadyPose(step.world, step.headingDeg!!)
        onSteady?.invoke(id, step.world, step.headingDeg)
      }
    }
    return steps
  }

  /** Forgets the rings in view: each must gather a steady pose afresh. */
  fun resetLocks() {
    tracks.clear()
    lastSteps.clear()
  }

  /** The averaged poses of the space's rings that were steady on the newest frame. */
  fun steadyPoses(): Map<Long, SteadyPose> =
      lastSteps.filterValues { it.gate == Gate.STEADY }.mapValues { (_, s) -> SteadyPose(s.world, s.headingDeg!!) }

  /** Places the scene: its origin at `root.position`, turned `root.yawDeg` about +Y. */
  fun setRoot(root: RootPose) {
    this.root = root
    view.setRoot(root)
  }

  /** Where the scene is placed while it is shown; null before it is placed and once it is hidden. */
  fun rootOf(): RootPose? = root

  /** Fades the scene in. */
  fun show() = view.setVisible(true, clock())

  /** Fades the scene out. */
  fun hide() {
    view.setVisible(false, clock())
    root = null
    outline.clear()
  }

  /** Hides the scene at once, without a fade (it is in the wrong place). */
  fun hideNow() {
    view.hideNow()
    root = null
    outline.clear()
  }

  /** Flashes the outline on [ringId] where it last became steady, if it has and is one of the space's rings. */
  fun flashOutline(ringId: Long) {
    val at = lockedAt[ringId] ?: return
    val marker = snapshot?.space?.markerByRing(ringId)?.second ?: return
    outline.flash(at.world, at.headingDeg, marker.diameterMm / 1000.0, clock())
  }

  /** Advances the fade and the outline; call every frame. */
  fun tick() {
    val now = clock()
    view.tick(now)
    outline.tick(now)
  }

  /** How many items the scene has. */
  fun itemCount(): Int = view.count()

  private fun Vector3.vec() = Vec3(x.toDouble(), y.toDouble(), z.toDouble())

  private companion object {
    const val TAG = "VLMSpaces"
  }
}
