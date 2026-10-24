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

/** The plain words shown when something goes wrong. */
object VisitorCopy {
  const val NOT_OPEN = "This space isn't open right now."
  const val OFFLINE = "Can't reach VLM. Check the headset's Wi-Fi."
  const val BUSY = "VLM is busy. Trying again…"
  const val COULDNT_OPEN = "Couldn't open this space. Try again in a moment."
  const val BAD_DATA = "Something's wrong with this space's data."
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
  /** The answer to a [VisitorEffect.Lookup]. [ringId] is the ring that asked; for [OpenSpace] lookups it is ignored. */
  data class Lookup(val ringId: Long, val result: ApiResult<MarkerLookup>) : VisitorEvent
  data class Feed(val snapshot: ArFeedSnapshot) : VisitorEvent
  data class FeedStatus(val status: FeedConnection) : VisitorEvent
  data class Steady(val ringId: Long, val world: Vec3, val headingDeg: Double) : VisitorEvent
  data object TrackingJump : VisitorEvent
  data object HeadsetOff : VisitorEvent
  data object HeadsetOn : VisitorEvent
  data object LookAgain : VisitorEvent
  data class OpenSpace(val code: String) : VisitorEvent
}

sealed interface VisitorEffect {
  data class Lookup(val code: String) : VisitorEffect
  data class StartFeed(val spaceId: String) : VisitorEffect
  data object StopFeed : VisitorEffect
  data class ShowScene(val root: RootPose) : VisitorEffect
  data class Reanchor(val root: RootPose) : VisitorEffect
  data object HideScene : VisitorEffect
  data class FlashOutline(val ringId: Long) : VisitorEffect
  data object ResetAveragers : VisitorEffect
  /** `null` = accept any ring (used while searching). */
  data class SetRegistered(val ids: Set<Long>?) : VisitorEffect
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
  /** The ring that started the pending lookup; null for a lookup from [VisitorEvent.OpenSpace]. */
  private var lookupRing: Long? = null
  private val doNotAskUntil = mutableMapOf<Long, Long>()

  fun on(event: VisitorEvent, nowMs: Long): List<VisitorEffect> =
      when (event) {
        is VisitorEvent.UnreadableSeen -> unreadable(event.sinceMs, nowMs)
        is VisitorEvent.RingAgreed -> ringAgreed(event.ringId, nowMs)
        is VisitorEvent.Lookup -> lookup(event, nowMs)
        is VisitorEvent.Feed -> feed(event.snapshot)
        is VisitorEvent.FeedStatus -> feedStatus(event.status)
        is VisitorEvent.Steady -> steady(event)
        VisitorEvent.TrackingJump,
        VisitorEvent.HeadsetOff -> hide()
        VisitorEvent.HeadsetOn -> emptyList()
        VisitorEvent.LookAgain -> forget(listOf(VisitorEffect.SetRegistered(null))) { VisitorState.Hint }
        is VisitorEvent.OpenSpace ->
            forget(listOf(VisitorEffect.SetRegistered(null))) { VisitorState.Loading(event.code, null) }
                .also { lookupRing = null }
                .plus(VisitorEffect.Lookup(event.code))
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
    if ((doNotAskUntil[ringId] ?: Long.MIN_VALUE) > nowMs) return emptyList()
    val code = RingCodec.codeOf(ringId)
    lookupRing = ringId
    state = VisitorState.Loading(code, null)
    return listOf(VisitorEffect.Lookup(code))
  }

  private fun lookup(e: VisitorEvent.Lookup, nowMs: Long): List<VisitorEffect> {
    val loading = state as? VisitorState.Loading ?: return emptyList()
    if (loading.spaceName != null || feedSpaceId != null) return emptyList()
    if (lookupRing != null && lookupRing != e.ringId) return emptyList()
    when (val r = e.result) {
      is ApiResult.Ok -> {
        feedSpaceId = r.value.spaceId
        state = loading.copy(spaceName = r.value.spaceName)
        return listOf(VisitorEffect.StartFeed(r.value.spaceId))
      }
      ApiResult.NotFound -> {
        val ring = lookupRing
        if (ring != null) {
          doNotAskUntil[ring] = nowMs + VisitorTuning.NOT_FOUND_RETRY_MS
          state = VisitorState.Hint
        } else {
          state = VisitorState.Failed(VisitorCopy.NOT_OPEN)
        }
      }
      ApiResult.Offline -> state = VisitorState.Failed(VisitorCopy.OFFLINE)
      ApiResult.RateLimited -> state = VisitorState.Failed(VisitorCopy.BUSY)
      is ApiResult.Failed ->
          state = VisitorState.Failed(if (r.status == 200) VisitorCopy.BAD_DATA else VisitorCopy.COULDNT_OPEN)
    }
    lookupRing = null
    return emptyList()
  }

  private fun feed(snapshot: ArFeedSnapshot): List<VisitorEffect> {
    if (feedSpaceId == null || snapshot.space.id != feedSpaceId) return emptyList()
    val s = snapshot.space
    val ids = ringIds(s)
    val changed = space?.let { ringIds(it) != ids } ?: true
    val first = space == null
    space = s
    state =
        when (val st = state) {
          is VisitorState.Shown -> st.copy(space = s)
          is VisitorState.Locking -> VisitorState.Locking(s)
          else -> if (first || st is VisitorState.NotSetUp || st is VisitorState.Failed) VisitorState.Locking(s) else st
        }
    return if (changed) listOf(VisitorEffect.SetRegistered(ids)) else emptyList()
  }

  private fun feedStatus(status: FeedConnection): List<VisitorEffect> {
    if (feedSpaceId == null) return emptyList()
    return when (status) {
      FeedConnection.NOT_FOUND -> {
        // The feed reports this but doesn't clear the scene, so do it here, shown or not.
        feedSpaceId = null
        space = null
        state = VisitorState.Failed(VisitorCopy.NOT_OPEN)
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

  /** Tracking jumped or the headset came off: hide, and wait for a ring to be seen again. The feed keeps running. */
  private fun hide(): List<VisitorEffect> {
    val s = space ?: return emptyList()
    state = VisitorState.Locking(s)
    return listOf(VisitorEffect.HideScene, VisitorEffect.ResetAveragers)
  }

  /** Drops the current space and everything pending, moving to the state [next] gives. */
  private fun forget(extra: List<VisitorEffect>, next: () -> VisitorState): List<VisitorEffect> {
    val fx = mutableListOf<VisitorEffect>()
    if (space != null) fx += VisitorEffect.HideScene
    fx += VisitorEffect.StopFeed
    fx += VisitorEffect.ResetAveragers
    fx += extra
    feedSpaceId = null
    space = null
    lookupRing = null
    state = next()
    return fx
  }

  private fun ringIds(s: ArSpace): Set<Long> = s.floors.flatMap { f -> f.markers.map { it.ringId } }.toSet()
}
