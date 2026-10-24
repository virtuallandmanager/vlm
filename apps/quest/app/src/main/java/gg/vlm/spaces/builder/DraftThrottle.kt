package gg.vlm.spaces.builder

/** Lets a draft through at most [perSecond] times a second per item (the server allows 20; the headset keeps to 10). */
class DraftThrottle(private val clock: () -> Long, perSecond: Int = 10) {
  private val gapMs = 1000L / perSecond
  private val lastSent = HashMap<String, Long>()

  /** True if the draft of [sk] may be sent now (and counts as sent). */
  @Synchronized
  fun allow(sk: String): Boolean {
    val t = clock()
    val last = lastSent[sk]
    if (last != null && t - last < gapMs) return false
    lastSent[sk] = t
    return true
  }

  /** Forgets [sk], so its next draft goes straight out. */
  @Synchronized fun reset(sk: String) {
    lastSent.remove(sk)
  }
}
