package gg.vlm.spaces.visitor

/**
 * Turns "this camera frame had a ring seen but not readable" into the flow's events: [VisitorEvent.UnreadableSeen]
 * with when the run of sightings began (short gaps don't restart it), and one [VisitorEvent.UnreadableGone] once
 * none has been seen for [goneAfterMs].
 */
class UnreadableWatch(private val goneAfterMs: Long = VisitorTuning.UNREADABLE_HINT_MS) {
  private var since: Long? = null
  private var lastSeen = 0L

  fun onFrame(seen: Boolean, nowMs: Long): VisitorEvent? {
    if (seen) {
      val s = since ?: nowMs.also { since = it }
      lastSeen = nowMs
      return VisitorEvent.UnreadableSeen(s)
    }
    if (since != null && nowMs - lastSeen >= goneAfterMs) {
      since = null
      return VisitorEvent.UnreadableGone
    }
    return null
  }

  fun reset() {
    since = null
  }
}
