package io.virvi.ar.api

import io.virvi.ar.space.SpaceFeed
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/** OFFLINE: unreachable. BAD_DATA: a 200 that couldn't be parsed. FAILED: any other error status. */
enum class FeedStatus { CONNECTING, LIVE, OFFLINE, RATE_LIMITED, NOT_FOUND, BAD_DATA, FAILED }

/**
 * Long-polls a space's feed. Each answer is a whole snapshot; [onSnapshot] fires only when the version changes.
 * Failures back off (doubling, 1 s to 30 s) and keep the last snapshot; a 404 (unpublished or unknown space) reports
 * NOT_FOUND and stops. Callbacks run on [scope]'s dispatcher (the main thread in the app).
 */
class ArFeed(
    private val scope: CoroutineScope,
    private val api: ArApi,
    private val onStatus: (FeedStatus) -> Unit,
    private val onSnapshot: (ArFeedSnapshot) -> Unit,
) : SpaceFeed {
  private var job: Job? = null

  override fun start(spaceId: String, token: (() -> String?)?) {
    stop()
    onStatus(FeedStatus.CONNECTING)
    job = scope.launch { loop(spaceId, token) }
  }

  override fun stop() {
    job?.cancel()
    job = null
  }

  private suspend fun loop(spaceId: String, token: (() -> String?)?) {
    var version = ""
    var wait = 0.0
    while (scope.isActive) {
      when (val r = api.feed(spaceId, version, token?.invoke())) {
        is ApiResult.Ok -> {
          wait = 0.0
          if (r.value.version != version) {
            version = r.value.version
            onSnapshot(r.value)
          }
          onStatus(FeedStatus.LIVE)
          continue
        }
        ApiResult.NotFound -> return onStatus(FeedStatus.NOT_FOUND)
        ApiResult.RateLimited -> onStatus(FeedStatus.RATE_LIMITED)
        ApiResult.Offline -> onStatus(FeedStatus.OFFLINE)
        is ApiResult.Failed -> onStatus(if (r.status == 200) FeedStatus.BAD_DATA else FeedStatus.FAILED)
      }
      wait = minOf(maxOf(wait * 2, 1.0), 30.0)
      delay((wait * 1000).toLong())
    }
  }
}
