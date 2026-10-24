package gg.vlm.spaces.builder

import gg.vlm.spaces.api.DeviceKind

enum class Resume { RESUME_WITH_DRAFTS, RESUME_DRAFTS_EXPIRED, SIGNED_OUT }

/**
 * Rules for a builder session across the headset coming off and on. Personal headsets keep drafts for 10 minutes off;
 * shared headsets end the session after more than 2 minutes off. [clock] returns milliseconds.
 * The caller acts on the result (drops drafts, runs `DeviceAuth.endSession()`).
 */
class BuilderSession(private val kind: DeviceKind, private val clock: () -> Long) {
  private var offSince: Long? = null
  private var ended = false

  fun headsetOff() {
    if (ended || offSince != null) return
    offSince = clock()
  }

  fun headsetOn(): Resume {
    if (ended) return Resume.SIGNED_OUT
    val since = offSince ?: return Resume.RESUME_WITH_DRAFTS
    offSince = null
    val away = clock() - since
    return when (kind) {
      DeviceKind.PERSONAL ->
        if (away > PERSONAL_DRAFTS_MS) Resume.RESUME_DRAFTS_EXPIRED else Resume.RESUME_WITH_DRAFTS
      DeviceKind.SHARED ->
        if (away > SHARED_SESSION_MS) {
          ended = true
          Resume.SIGNED_OUT
        } else {
          Resume.RESUME_WITH_DRAFTS
        }
    }
  }

  fun done() {
    ended = true
  }

  fun signOut() {
    ended = true
  }

  /** True when a shared session's off time has passed 2 minutes while the headset is still off. */
  fun tick(): Boolean {
    val since = offSince ?: return false
    return !ended && kind == DeviceKind.SHARED && clock() - since > SHARED_SESSION_MS
  }

  private companion object {
    const val PERSONAL_DRAFTS_MS = 10 * 60_000L
    const val SHARED_SESSION_MS = 2 * 60_000L
  }
}
