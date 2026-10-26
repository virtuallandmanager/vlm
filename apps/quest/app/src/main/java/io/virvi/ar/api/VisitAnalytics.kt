package io.virvi.ar.api

import io.virvi.ar.Vec3
import java.util.UUID
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Anonymous visit analytics, reported as platform `ar-quest`. One visit runs from the first [shown] of a space until
 * [end]; [hidden] only pauses it (a tracking jump re-shows the same space). The playerId is a fresh random UUID per
 * visit, never stored and never tied to the device. Events are timestamped with [clock] (epoch ms, as the server
 * checks them) and queued until [flush] posts them; a post to retry keeps them (up to [MAX_QUEUED]) for the next flush,
 * and one the server refused for good ([AnalyticsPost.Drop]) drops that space's batch.
 * Main thread only.
 */
class VisitAnalytics(
    private val post: suspend (spaceId: String, body: String) -> AnalyticsPost,
    private val clock: () -> Long,
) {
  private class Queued(val spaceId: String, val type: String, val playerId: String, val t: Long, val pos: Vec3? = null)

  private val queue = ArrayList<Queued>()
  private var spaceId: String? = null
  private var playerId: String? = null
  private var lastPosAt = Long.MIN_VALUE
  private var paused = false
  private val flushing = Mutex()

  /** The scene is up. Starts a visit, unless this space's visit is already running (a re-show). */
  fun shown(spaceId: String) {
    if (this.spaceId == spaceId && playerId != null) {
      paused = false
      return
    }
    end()
    this.spaceId = spaceId
    playerId = UUID.randomUUID().toString()
    lastPosAt = Long.MIN_VALUE
    paused = false
    add("enter", null)
  }

  /** The head in scene coordinates; at most one `pos` per 5 s. Ignored while paused or between visits. */
  fun position(scenePos: Vec3) {
    if (playerId == null || paused) return
    if (!listOf(scenePos.x, scenePos.y, scenePos.z).all { it.isFinite() }) return
    val now = clock()
    if (lastPosAt != Long.MIN_VALUE && now - lastPosAt < POS_INTERVAL_MS) return
    lastPosAt = now
    add("pos", scenePos)
  }

  /** The scene is hidden but the visit goes on. */
  fun hidden() {
    paused = true
  }

  /** Ends the visit with `leave`; the caller flushes after it. */
  fun end() {
    if (spaceId != null && playerId != null) add("leave", null)
    spaceId = null
    playerId = null
    paused = false
  }

  private fun add(type: String, pos: Vec3?) {
    queue += Queued(spaceId!!, type, playerId!!, clock(), pos)
    while (queue.size > MAX_QUEUED) queue.removeAt(0)
  }

  /** Posts what is queued, one request per space and at most [MAX_QUEUED] events each. Retries stay queued. */
  suspend fun flush() {
    flushing.withLock {
      for (id in queue.map { it.spaceId }.distinct()) {
        val batch = queue.filter { it.spaceId == id }.take(MAX_QUEUED)
        if (batch.isEmpty()) continue
        val result =
            try {
              post(id, body(batch))
            } catch (e: kotlin.coroutines.cancellation.CancellationException) {
              throw e
            } catch (e: Exception) {
              AnalyticsPost.Retry
            }
        if (result != AnalyticsPost.Retry) queue.removeAll { q -> batch.any { it === q } }
      }
    }
  }

  private fun body(events: List<Queued>) =
      buildJsonObject {
            put("v", 1)
            put("platform", "ar-quest")
            put(
                "events",
                JsonArray(
                    events.map { e ->
                      buildJsonObject {
                        put("type", e.type)
                        put("playerId", e.playerId)
                        put("t", e.t)
                        e.pos?.let {
                          put("x", JsonPrimitive(it.x))
                          put("y", JsonPrimitive(it.y))
                          put("z", JsonPrimitive(it.z))
                        }
                      }
                    }),
            )
          }
          .toString()

  companion object {
    const val MAX_QUEUED = 200
    const val POS_INTERVAL_MS = 5_000L
  }
}
