package io.virvi.ar.builder

/**
 * At most [perSecond] live drafts a second per item. A draft [allow] turns away is remembered, so the last pose
 * of a drag still goes out: [due] returns the items whose held-back draft may be sent now, and [flush] lets one out
 * at once (the drag ended). The caller sends the item's latest draft each time.
 */
class DraftThrottle(private val clock: () -> Long, perSecond: Int = 10) {
  private val gapMs = 1000L / perSecond
  private val lastSent = HashMap<String, Long>()
  /** Items with a draft turned away since their last send. */
  private val pending = LinkedHashSet<String>()

  /** True if the draft of [sk] may be sent now (and counts as sent); false holds it back for [due] or [flush]. */
  @Synchronized
  fun allow(sk: String): Boolean {
    val t = clock()
    val last = lastSent[sk]
    if (last != null && t - last < gapMs) {
      pending += sk
      return false
    }
    lastSent[sk] = t
    pending -= sk
    return true
  }

  /** The items whose held-back draft may go out now; each counts as sent. Call every frame. */
  @Synchronized
  fun due(): List<String> {
    val t = clock()
    val ready = pending.filter { sk -> lastSent[sk].let { it == null || t - it >= gapMs } }
    ready.forEach { sk ->
      pending -= sk
      lastSent[sk] = t
    }
    return ready
  }

  /** True if [sk] had a draft held back: send it now, whatever the gap (the drag ended). It counts as sent. */
  @Synchronized
  fun flush(sk: String): Boolean {
    if (!pending.remove(sk)) return false
    lastSent[sk] = clock()
    return true
  }

  /** Forgets [sk], held-back draft included, so its next draft goes straight out. */
  @Synchronized
  fun reset(sk: String) {
    lastSent.remove(sk)
    pending.remove(sk)
  }
}
