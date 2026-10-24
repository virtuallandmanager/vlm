package gg.vlm.spaces.visitor

import gg.vlm.spaces.Vec3
import gg.vlm.spaces.api.ApiResult
import gg.vlm.spaces.api.ArFeedSnapshot
import gg.vlm.spaces.api.ArSpace
import gg.vlm.spaces.api.FeedStatus as FeedConnection
import gg.vlm.spaces.api.MarkerLookup
import gg.vlm.spaces.ring.RingCodec
import gg.vlm.spaces.space.RootPose
import gg.vlm.spaces.space.rootFromMarker

/** The visitor's words, kept word for word (the plan's Global Constraints), and the plain words for failures. */
object VisitorCopy {
  const val HINT = "Look for a ring like this, at eye level near the entrance."
  const val TOO_FAR = "Step closer to the ring"
  const val HOLD_STILL = "Hold still…"
  const val NOT_SET_UP = "This space isn't set up yet"
  const val LOOK_AGAIN = "Look at the ring again"
  const val HIDE_BEHIND_WALLS = "Hide behind walls"
  const val LIVE_DEPTH = "Live depth"
  const val OCCLUSION_OFF = "Off"
  const val SPACES = "Spaces"
  const val NO_SPACES = "No spaces yet"
  const val LOOK_AT_RING = "Look at the ring when you get there"
  const val CLOSE = "Close"
  const val BUILDER = "Builder"
  const val BUILDER_SOON = "Builder mode is coming soon"

  fun opening(spaceName: String?) = if (spaceName == null) "Opening…" else "Opening $spaceName…"

  const val NOT_OPEN = "This space isn't open right now."
  const val OFFLINE = "Can't reach VLM. Check the headset's Wi-Fi."
  const val BUSY = "VLM is busy. Trying again…"
  const val COULDNT_OPEN = "Couldn't open this space. Try again in a moment."
  const val BAD_DATA = "Something's wrong with this space's data."

  // New copy from the whole-branch review (the owner may reword these; see the README).
  const val NO_ROOM_SCAN = "Set up your space on this headset first: Settings → Physical space → Space setup."
  const val NO_CAMERA = "VLM Spaces needs camera access to find rings. Allow it in Settings → Apps → VLM Spaces."
  const val NO_WALL = "Can't see the wall behind this ring. Look around the room so the headset can map it."
}

sealed interface VisitorState {
  data object Hint : VisitorState
  data object StepCloser : VisitorState
  /** [spaceName] is null until the lookup has answered. */
  data class Loading(val code: String, val spaceName: String?) : VisitorState
  data class NotSetUp(val spaceName: String) : VisitorState
  data class Failed(val message: String) : VisitorState
  data class Locking(val space: ArSpace) : VisitorState
  data class Shown(val space: ArSpace, val root: RootPose) : VisitorState
}

sealed interface VisitorEvent {
  data class UnreadableSeen(val sinceMs: Long) : VisitorEvent
  data class RingAgreed(val ringId: Long) : VisitorEvent
  /** The answer to a [VisitorEffect.Lookup] for [code]; answers for any other code are dropped. */
  data class Lookup(val code: String, val result: ApiResult<MarkerLookup>) : VisitorEvent
  /** No unreadable candidate has been seen for a while: "Step closer" goes back to the hint. */
  data object UnreadableGone : VisitorEvent
  data class Feed(val snapshot: ArFeedSnapshot) : VisitorEvent
  data class FeedStatus(val status: FeedConnection) : VisitorEvent
  data class Steady(val ringId: Long, val world: Vec3, val headingDeg: Double) : VisitorEvent
  data object TrackingJump : VisitorEvent
  data object HeadsetOff : VisitorEvent
  data object HeadsetOn : VisitorEvent
  data object LookAgain : VisitorEvent
  data class OpenSpace(val code: String) : VisitorEvent
  /** Time has passed (sent every frame): lets a stale "isn't open" go back to the hint. */
  data object Tick : VisitorEvent
}

sealed interface VisitorEffect {
  data class Lookup(val code: String) : VisitorEffect
  data class StartFeed(val spaceId: String) : VisitorEffect
  data object StopFeed : VisitorEffect
  data class ShowScene(val root: RootPose) : VisitorEffect
  data class Reanchor(val root: RootPose) : VisitorEffect
  /** Fade the scene out. */
  data object HideScene : VisitorEffect
  /** Hide the scene at once, without a fade (tracking jumped: it is in the wrong place). */
  data object HideNow : VisitorEffect
  data class FlashOutline(val ringId: Long) : VisitorEffect
  data object ResetAveragers : VisitorEffect
  /** `null` = accept any ring (used while searching). */
  data class SetRegistered(val ids: Set<Long>?) : VisitorEffect
  /** Open the space page for [code] (a link or a Spaces pick). */
  data class ShowSpacePage(val code: String) : VisitorEffect
  /** Close the space page: the space it was for is forgotten. */
  data object CloseSpacePage : VisitorEffect
}

/**
 * The visitor's journey as a pure state machine: rings in, effects out. Wrong placement is worse than a delay, so a
 * scene appears only on [VisitorEvent.Steady] and any doubt hides it. Once a space is loaded only its own rings count.
 */
class VisitorFlow {
  var state: VisitorState = VisitorState.Hint
    private set

  /** The space whose feed we are following, from the lookup answer; null while searching. */
  private var feedSpaceId: String? = null
  /** The space itself, from its first snapshot. */
  private var space: ArSpace? = null
  /** The code of the lookup we are waiting on, and the ring that started it (null for [VisitorEvent.OpenSpace]). */
  private var pendingCode: String? = null
  private var lookupRing: Long? = null
  /** The ring whose lookup started the feed we are following (null for [VisitorEvent.OpenSpace]). */
  private var feedRing: Long? = null
  /** While "isn't open" is up for a ring on the do-not-ask list: that ring, and when it was last agreed. */
  private var notOpenRing: Long? = null
  private var notOpenSeenMs = 0L
  private val doNotAskUntil = mutableMapOf<Long, Long>()
  private val retryAt = mutableMapOf<Long, Long>()
  private val retryDelay = mutableMapOf<Long, Long>()

  /** A space has been chosen (its lookup answered) and not forgotten; its feed may still be loading. */
  val spaceChosen: Boolean
    get() = feedSpaceId != null

  fun on(event: VisitorEvent, nowMs: Long): List<VisitorEffect> =
      when (event) {
        is VisitorEvent.UnreadableSeen -> unreadable(event.sinceMs, nowMs)
        VisitorEvent.UnreadableGone -> {
          if (state == VisitorState.StepCloser) state = VisitorState.Hint
          emptyList()
        }
        is VisitorEvent.RingAgreed -> ringAgreed(event.ringId, nowMs)
        is VisitorEvent.Lookup -> lookup(event, nowMs)
        is VisitorEvent.Feed -> feed(event.snapshot)
        is VisitorEvent.FeedStatus -> feedStatus(event.status, nowMs)
        is VisitorEvent.Steady -> steady(event)
        VisitorEvent.TrackingJump -> hide()
        VisitorEvent.HeadsetOff -> hide()
        VisitorEvent.HeadsetOn -> emptyList()
        VisitorEvent.LookAgain -> forget(listOf(VisitorEffect.SetRegistered(null))) { VisitorState.Hint }
        is VisitorEvent.OpenSpace ->
            forget(listOf(VisitorEffect.SetRegistered(null))) { VisitorState.Loading(event.code, null) }
                .also { pendingCode = event.code }
                .plus(listOf(VisitorEffect.ShowSpacePage(event.code), VisitorEffect.Lookup(event.code)))
        VisitorEvent.Tick -> tick(nowMs)
      }

  /** A ring on the do-not-ask list that has left view for a while no longer holds "isn't open": back to the hint. */
  private fun tick(nowMs: Long): List<VisitorEffect> {
    if (notOpenRing != null && state == VisitorState.Failed(VisitorCopy.NOT_OPEN) &&
        nowMs - notOpenSeenMs >= VisitorTuning.UNREADABLE_HINT_MS) {
      notOpenRing = null
      state = VisitorState.Hint
    }
    return emptyList()
  }

  private fun unreadable(sinceMs: Long, nowMs: Long): List<VisitorEffect> {
    if (state == VisitorState.Hint || state == VisitorState.StepCloser) {
      state =
          if (nowMs - sinceMs >= VisitorTuning.UNREADABLE_HINT_MS) VisitorState.StepCloser else VisitorState.Hint
    }
    return emptyList()
  }

  private fun ringAgreed(ringId: Long, nowMs: Long): List<VisitorEffect> {
    // Once a space is chosen (looked up or loaded) other rings never swap it; only LookAgain does.
    if (feedSpaceId != null || state is VisitorState.Loading) return emptyList()
    if ((doNotAskUntil[ringId] ?: Long.MIN_VALUE) > nowMs) {
      state = VisitorState.Failed(VisitorCopy.NOT_OPEN)
      notOpenRing = ringId
      notOpenSeenMs = nowMs
      return emptyList()
    }
    // A failed lookup holds its message until the retry time, so it can't flicker or hammer the server.
    if ((retryAt[ringId] ?: Long.MIN_VALUE) > nowMs) return emptyList()
    notOpenRing = null
    val code = RingCodec.codeOf(ringId)
    lookupRing = ringId
    pendingCode = code
    state = VisitorState.Loading(code, null)
    return listOf(VisitorEffect.Lookup(code))
  }

  private fun lookup(e: VisitorEvent.Lookup, nowMs: Long): List<VisitorEffect> {
    val loading = state as? VisitorState.Loading ?: return emptyList()
    if (loading.spaceName != null || feedSpaceId != null) return emptyList()
    if (pendingCode != e.code) return emptyList()
    val ring = lookupRing
    when (val r = e.result) {
      is ApiResult.Ok -> {
        feedSpaceId = r.value.spaceId
        feedRing = ring
        pendingCode = null
        lookupRing = null
        // The backoff itself is only reset by the feed's first snapshot: a space that answers here but whose feed
        // says not found must not loop on lookups.
        if (ring != null) retryAt.remove(ring)
        state = loading.copy(spaceName = r.value.spaceName)
        return listOf(VisitorEffect.StartFeed(r.value.spaceId))
      }
      ApiResult.NotFound -> {
        if (ring != null) {
          doNotAskUntil[ring] = nowMs + VisitorTuning.NOT_FOUND_RETRY_MS
          notOpenRing = ring
          notOpenSeenMs = nowMs
        }
        state = VisitorState.Failed(VisitorCopy.NOT_OPEN)
      }
      ApiResult.Offline -> failed(ring, nowMs, VisitorCopy.OFFLINE)
      ApiResult.RateLimited -> failed(ring, nowMs, VisitorCopy.BUSY)
      is ApiResult.Failed ->
          failed(ring, nowMs, if (r.status == 200) VisitorCopy.BAD_DATA else VisitorCopy.COULDNT_OPEN)
    }
    pendingCode = null
    lookupRing = null
    return emptyList()
  }

  private fun failed(ring: Long?, nowMs: Long, message: String) {
    state = VisitorState.Failed(message)
    if (ring == null) return
    val delay = retryDelay[ring]?.let { minOf(it * 2, VisitorTuning.LOOKUP_RETRY_MAX_MS) } ?: VisitorTuning.LOOKUP_RETRY_MIN_MS
    retryDelay[ring] = delay
    retryAt[ring] = nowMs + delay
  }

  private fun feed(snapshot: ArFeedSnapshot): List<VisitorEffect> {
    if (feedSpaceId == null || snapshot.space.id != feedSpaceId) return emptyList()
    val s = snapshot.space
    val ids = ringIds(s)
    val changed = space?.let { ringIds(it) != ids } ?: true
    val first = space == null
    space = s
    if (first) feedRing?.let(retryDelay::remove)
    state =
        when (val st = state) {
          is VisitorState.Shown -> st.copy(space = s)
          is VisitorState.Locking -> VisitorState.Locking(s)
          else -> if (first || st is VisitorState.NotSetUp || st is VisitorState.Failed) VisitorState.Locking(s) else st
        }
    return if (changed) listOf(VisitorEffect.SetRegistered(ids)) else emptyList()
  }

  private fun feedStatus(status: FeedConnection, nowMs: Long): List<VisitorEffect> {
    if (feedSpaceId == null) return emptyList()
    return when (status) {
      FeedConnection.NOT_FOUND -> {
        // The feed reports this but doesn't clear the scene, so do it here, shown or not. The ring goes on the retry
        // backoff: its lookup may well answer again, and the feed say not found again.
        feedSpaceId = null
        space = null
        failed(feedRing, nowMs, VisitorCopy.NOT_OPEN)
        feedRing = null
        listOf(
            VisitorEffect.HideScene,
            VisitorEffect.StopFeed,
            VisitorEffect.ResetAveragers,
            VisitorEffect.SetRegistered(null),
        )
      }
      FeedConnection.OFFLINE -> {
        if (space == null) state = VisitorState.Failed(VisitorCopy.OFFLINE)
        emptyList()
      }
      FeedConnection.RATE_LIMITED -> {
        if (space == null) state = VisitorState.Failed(VisitorCopy.BUSY)
        emptyList()
      }
      FeedConnection.BAD_DATA -> {
        if (space == null) state = VisitorState.Failed(VisitorCopy.BAD_DATA)
        emptyList()
      }
      FeedConnection.FAILED -> {
        if (space == null) state = VisitorState.Failed(VisitorCopy.COULDNT_OPEN)
        emptyList()
      }
      FeedConnection.CONNECTING,
      FeedConnection.LIVE -> emptyList()
    }
  }

  private fun steady(e: VisitorEvent.Steady): List<VisitorEffect> {
    val s = space ?: return emptyList()
    val (_, marker) = s.markerByRing(e.ringId) ?: return emptyList()
    val shown = state as? VisitorState.Shown
    val saved = marker.pose
    if (saved == null) {
      // Never place from a guess. A scene already shown from another ring stays.
      if (shown == null) state = VisitorState.NotSetUp(s.name)
      return emptyList()
    }
    val root = rootFromMarker(e.world, e.headingDeg, saved)
    state = VisitorState.Shown(s, root)
    return if (shown != null) listOf(VisitorEffect.Reanchor(root))
    else listOf(VisitorEffect.ShowScene(root), VisitorEffect.FlashOutline(e.ringId))
  }

  /**
   * Tracking jumped or the headset came off: hide at once (a kept-loaded scene must not linger at a stale root), and
   * wait for a ring to be seen again. The feed keeps running.
   */
  private fun hide(): List<VisitorEffect> {
    val s = space ?: return emptyList()
    state = VisitorState.Locking(s)
    return listOf(VisitorEffect.HideNow, VisitorEffect.ResetAveragers)
  }

  /** Drops the current space, its page and everything pending, moving to the state [next] gives. */
  private fun forget(extra: List<VisitorEffect>, next: () -> VisitorState): List<VisitorEffect> {
    val fx = mutableListOf<VisitorEffect>()
    if (space != null) fx += VisitorEffect.HideScene
    fx += VisitorEffect.StopFeed
    fx += VisitorEffect.ResetAveragers
    fx += VisitorEffect.CloseSpacePage
    fx += extra
    feedSpaceId = null
    feedRing = null
    space = null
    lookupRing = null
    pendingCode = null
    notOpenRing = null
    // A fresh look starts fresh: a failed lookup's backoff would otherwise hold the hint for up to 30 s.
    retryAt.clear()
    retryDelay.clear()
    state = next()
    return fx
  }

  private fun ringIds(s: ArSpace): Set<Long> = s.floors.flatMap { f -> f.markers.map { it.ringId } }.toSet()
}
