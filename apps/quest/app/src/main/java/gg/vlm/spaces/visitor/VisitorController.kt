package gg.vlm.spaces.visitor

import android.os.SystemClock
import android.util.Log
import com.meta.spatial.core.Pose
import com.meta.spatial.core.Vector3
import gg.vlm.spaces.AppPrefs
import gg.vlm.spaces.AppState
import gg.vlm.spaces.SceneRenderer
import gg.vlm.spaces.Vec3
import gg.vlm.spaces.api.ApiResult
import gg.vlm.spaces.api.ArApi
import gg.vlm.spaces.api.ArFeed
import gg.vlm.spaces.api.ArFeedSnapshot
import gg.vlm.spaces.api.ArSpace
import gg.vlm.spaces.api.FeedStatus
import gg.vlm.spaces.api.VisitAnalytics
import gg.vlm.spaces.planScene
import gg.vlm.spaces.ring.CameraIntrinsics
import gg.vlm.spaces.ring.RingCodec
import gg.vlm.spaces.ring.RingDetection
import gg.vlm.spaces.ring.WallPlane
import gg.vlm.spaces.ring.cameraToWorld
import gg.vlm.spaces.ring.circleNormals
import gg.vlm.spaces.ring.markerInCamera
import gg.vlm.spaces.ring.wallHeading
import gg.vlm.spaces.space.markerInScene
import kotlin.coroutines.cancellation.CancellationException
import kotlin.math.atan2
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * One camera frame's rings: the trusted ones (agreed by `RingTracker`), the last raw detection of any id (for the
 * developer panel), whether a ring was seen but not readable, and when the frame was processed
 * (SystemClock.elapsedRealtimeNanos).
 */
class CameraRings(
    val tracked: List<RingDetection>,
    val last: RingDetection?,
    val unreadable: Boolean,
    val receivedNs: Long,
)

/**
 * Visitor mode, joined to the headset: owns the [VisitorFlow] and the space's feed, turns camera rings, head poses and
 * the lifecycle into the flow's events, and carries out its effects on the [renderer], the ring outline and the ring
 * tracker ([setRegistered]). Writes what the hint card says into [ui]. Main thread only.
 */
class VisitorController(
    private val scope: CoroutineScope,
    baseUrl: String,
    private val renderer: SceneRenderer,
    private val prefs: AppPrefs,
    private val ui: AppState,
    private val setRegistered: (Set<Long>?) -> Unit,
) {
  private val api = ArApi(baseUrl)
  private val flow = VisitorFlow()
  private val feed = ArFeed(scope, api, onStatus = ::onFeedStatus, onSnapshot = ::onSnapshot)
  private val analytics = VisitAnalytics(api::postAnalytics, System::currentTimeMillis)
  private val outline = RingOutline()
  private val trackingWatch = TrackingWatch()
  private val unreadableWatch = UnreadableWatch()

  /** The space whose feed is running, and its latest snapshot's space (null until the first one). */
  private var feedSpaceId: String? = null
  private var space: ArSpace? = null

  /** The space's rings in view. */
  private val tracks = HashMap<Long, RingLock>()
  /** Where each ring last locked, for its outline. */
  private val lockedAt = HashMap<Long, Pair<Vec3, Double>>()
  private var lastFrameNs = 0L
  /** During Locking: the ring in view is too far away to lock (LockGate said TOO_FAR, none said STEADY). */
  private var tooFar = false

  /** The ring that last became steady, for naming the space a scene was just shown for. */
  private var steadyRing: Long? = null

  init {
    ui.recentSpaces = prefs.recentSpaces
    scope.launch {
      while (true) {
        delay(FLUSH_INTERVAL_MS)
        flushAnalytics()
      }
    }
    refreshUi()
  }

  /** Posts queued analytics; a failure stays queued for the next flush. */
  private suspend fun flushAnalytics() {
    try {
      analytics.flush()
    } catch (e: CancellationException) {
      throw e
    } catch (e: Exception) {
      Log.w(TAG, "Analytics flush failed", e)
    }
  }

  /** Ends the visit (the space is forgotten or the headset is off) and sends its `leave` at once. */
  private fun endVisit() {
    analytics.end()
    scope.launch { flushAnalytics() }
  }

  /** Call every frame with the head pose, the newest camera rings, the camera's intrinsics and the room's walls. */
  fun tick(head: Pose, rings: CameraRings?, k: CameraIntrinsics?, walls: List<WallPlane>) {
    val now = SystemClock.elapsedRealtime()
    if (head != Pose()) {
      (flow.state as? VisitorState.Shown)?.let { shown ->
        val p = markerInScene(shown.root, head.t.vec(), 0.0)
        analytics.position(Vec3(p.x, p.y, p.z))
      }
      val fwd = head.q.times(Vector3(0f, 0f, 1f))
      val yaw = Math.toDegrees(atan2(fwd.x.toDouble(), fwd.z.toDouble()))
      if (trackingWatch.onHead(head.t.vec(), yaw)) {
        Log.i(TAG, "Tracking jumped: hiding the scene")
        dispatch(VisitorEvent.TrackingJump)
      }
      val fresh = rings?.takeIf { SystemClock.elapsedRealtimeNanos() - it.receivedNs < STALE_NS }
      if (fresh == null) noRings(now)
      else if (fresh.receivedNs != lastFrameNs) {
        lastFrameNs = fresh.receivedNs
        onFrame(fresh, head, k, walls, now)
      }
    }
    renderer.tick(now)
    outline.tick(now)
    refreshUi()
  }

  fun headsetOff() {
    dispatch(VisitorEvent.HeadsetOff)
    endVisit()
    // A shared headset: the next person starts at the hint card with nothing loaded, unless a builder chose otherwise.
    if (!prefs.keepLoadedBetweenVisitors) dispatch(VisitorEvent.LookAgain)
    unreadableWatch.reset()
    lastFrameNs = 0L
  }

  fun headsetOn() {
    trackingWatch.reset()
    dispatch(VisitorEvent.HeadsetOn)
  }

  fun lookAgain() = dispatch(VisitorEvent.LookAgain)

  /** Opens the space with [code] (from a link or the Spaces list): shows its page and looks it up. */
  fun openSpace(code: String) {
    ui.spacePage = SpacePageInfo(code, null, null)
    dispatch(VisitorEvent.OpenSpace(code))
  }

  fun closeSpacePage() {
    ui.spacePage = null
  }

  fun stop() {
    feed.stop()
    outline.clear()
  }

  // ── rings ────────────────────────────────────────────────────────────

  private fun noRings(now: Long) {
    tracks.clear()
    tooFar = false
    unreadableWatch.onFrame(false, now)?.let(::dispatch)
  }

  private fun onFrame(f: CameraRings, head: Pose, k: CameraIntrinsics?, walls: List<WallPlane>, now: Long) {
    unreadableWatch.onFrame(f.unreadable, now)?.let(::dispatch)
    // The flow only acts on agreed rings while searching; there's no need to tell it every frame otherwise.
    val st = flow.state
    if (st == VisitorState.Hint || st == VisitorState.StepCloser || st is VisitorState.Failed) {
      for (d in f.tracked) dispatch(VisitorEvent.RingAgreed(d.id))
    }

    val seen = f.tracked.associateBy { it.id }
    tracks.keys.retainAll(seen.keys)
    var anyTooFar = false
    var anySteady = false
    for ((id, d) in seen) {
      val marker = space?.markerByRing(id)?.second ?: continue
      if (k == null) continue
      val w = cameraToWorld(markerInCamera(d, k, marker.diameterMm / 1000.0), head, k)
      val step =
          tracks.getOrPut(id) { RingLock() }.step(w.vec(), wallHeading(w, walls, head.t, circleNormals(d, k, head)), head.t.vec())
      if (step.gate == Gate.TOO_FAR) anyTooFar = true
      if (step.gate == Gate.STEADY) anySteady = true
      // A new steady pose locks on, or re-anchors a shown scene.
      if (step.becameSteady) {
        lockedAt[id] = step.world to step.headingDeg!!
        steadyRing = id
        dispatch(VisitorEvent.Steady(id, step.world, step.headingDeg))
      }
    }
    tooFar = anyTooFar && !anySteady
  }

  // ── feed ─────────────────────────────────────────────────────────────

  private fun onFeedStatus(s: FeedStatus) {
    ui.feed = s
    dispatch(VisitorEvent.FeedStatus(s))
  }

  /** An exception in here would end the feed's loop silently, so it's caught and logged. */
  private fun onSnapshot(snapshot: ArFeedSnapshot) {
    try {
      if (snapshot.space.id != feedSpaceId) return
      space = snapshot.space
      renderer.apply(planScene(snapshot.scene))
      dispatch(VisitorEvent.Feed(snapshot))
    } catch (e: Exception) {
      Log.e(TAG, "Snapshot ${snapshot.version} failed", e)
    }
  }

  // ── flow ─────────────────────────────────────────────────────────────

  /** Events raised while an event's effects are being carried out (the feed reports CONNECTING from inside start). */
  private val pending = ArrayDeque<VisitorEvent>()
  private var dispatching = false

  /** Hands [e] to the flow and carries out its effects; events raised meanwhile wait their turn. */
  private fun dispatch(e: VisitorEvent) {
    pending.addLast(e)
    if (dispatching) return
    dispatching = true
    try {
      while (pending.isNotEmpty()) {
        val next = pending.removeFirst()
        val now = SystemClock.elapsedRealtime()
        for (fx in flow.on(next, now)) run(fx, now)
      }
    } finally {
      // A throw must not leave events queued to replay, stale, on the next dispatch.
      pending.clear()
      dispatching = false
    }
    refreshUi()
  }

  private fun run(fx: VisitorEffect, now: Long) {
    when (fx) {
      is VisitorEffect.Lookup -> lookup(fx.code)
      is VisitorEffect.StartFeed -> {
        feedSpaceId = fx.spaceId
        space = null
        feed.start(fx.spaceId)
      }
      VisitorEffect.StopFeed -> {
        feed.stop()
        endVisit()
        feedSpaceId = null
        space = null
        ui.feed = null
        renderer.clear()
      }
      is VisitorEffect.ShowScene -> {
        // The scene is up, so the visit counts. The ring's own code names the space in the list.
        val s = space
        val ring = steadyRing
        if (s != null && ring != null) visited(RingCodec.codeOf(ring), s.name)
        space?.let { analytics.shown(it.id) }
        renderer.setRoot(fx.root)
        renderer.setVisible(true, now)
      }
      is VisitorEffect.Reanchor -> renderer.setRoot(fx.root)
      VisitorEffect.HideScene -> {
        renderer.setVisible(false, now)
        analytics.hidden()
        outline.clear()
      }
      VisitorEffect.HideNow -> {
        renderer.hideNow()
        analytics.hidden()
        outline.clear()
      }
      is VisitorEffect.FlashOutline -> {
        val at = lockedAt[fx.ringId]
        val marker = space?.markerByRing(fx.ringId)?.second
        if (at != null && marker != null) outline.flash(at.first, at.second, marker.diameterMm / 1000.0, now)
      }
      VisitorEffect.ResetAveragers -> {
        tracks.clear()
        tooFar = false
      }
      is VisitorEffect.SetRegistered -> setRegistered(fx.ids)
    }
  }

  private fun lookup(code: String) {
    scope.launch {
      val r =
          try {
            api.lookup(code)
          } catch (e: CancellationException) {
            throw e
          } catch (e: Exception) {
            Log.e(TAG, "Lookup failed", e)
            ApiResult.Failed(-1)
          }
      dispatch(VisitorEvent.Lookup(code, r))
      // Only a lookup the flow accepted counts; one it dropped as superseded is neither a visit nor the page's space.
      val accepted = (flow.state as? VisitorState.Loading)?.let { it.code == code && it.spaceName != null } == true
      if (r is ApiResult.Ok && accepted) {
        visited(code, r.value.spaceName)
        ui.spacePage = ui.spacePage?.takeIf { it.code == code }?.copy(spaceName = r.value.spaceName, whereText = r.value.whereText)
            ?: ui.spacePage
        refreshUi()
      }
    }
  }

  /** Puts the space first in the recent list and saves it. */
  private fun visited(code: String, spaceName: String) {
    val list = remember(ui.recentSpaces, RecentSpace(code, spaceName, System.currentTimeMillis()))
    ui.recentSpaces = list
    prefs.recentSpaces = list
  }

  private fun refreshUi() {
    val st = flow.state
    ui.spacePage = spacePageFor(ui.spacePage, st)
    ui.spaceProblem = if (ui.spacePage?.spaceName == null) (st as? VisitorState.Failed)?.message else null
    ui.hint = hintText(st, tooFar)
    ui.sceneShown = st is VisitorState.Shown
    ui.visitorState = st::class.simpleName ?: ""
    ui.itemCount = renderer.count()
  }

  private fun Vector3.vec() = Vec3(x.toDouble(), y.toDouble(), z.toDouble())

  companion object {
    private const val TAG = "VLMSpaces"
    /** A camera frame older than this (camera stalled or stopped) shows no rings. */
    private const val FLUSH_INTERVAL_MS = 10_000L
    private const val STALE_NS = 250_000_000L
  }
}
