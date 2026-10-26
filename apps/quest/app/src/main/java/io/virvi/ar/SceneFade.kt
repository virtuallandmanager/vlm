package io.virvi.ar

/**
 * The scene's show/hide state, without the SDK: [alpha] for images and videos, and whether they ([mediaOn]) and models
 * and sounds ([solidOn]) are drawn. Media are drawn while fading or shown; solids only once fully shown, and they go at
 * the end of a fade-out. [hideNow] and [clear] skip the fade. Main thread only.
 */
class SceneFade(private val fadeMs: Long = 400) {
  var alpha = 0f
    private set
  var mediaOn = false
    private set
  var solidOn = false
    private set
  private var target = 0f
  private var from = 0f
  private var start = 0L

  fun show(nowMs: Long) = fadeTo(1f, nowMs)

  fun hide(nowMs: Long) = fadeTo(0f, nowMs)

  /** Hidden at once (tracking jumped: the scene is in the wrong place). */
  fun hideNow() {
    alpha = 0f
    target = 0f
    from = 0f
    finish()
  }

  /** The items were removed: whatever comes next starts hidden. */
  fun clear() = hideNow()

  fun tick(nowMs: Long) {
    if (alpha != target) {
      val k = ((nowMs - start).toFloat() / fadeMs).coerceIn(0f, 1f)
      alpha = if (k >= 1f) target else from + (target - from) * k
    }
    if (alpha == target) finish()
  }

  private fun fadeTo(t: Float, nowMs: Long) {
    if (t == target) return
    target = t
    from = alpha
    start = nowMs
    if (t == 1f) mediaOn = true
    // Already there (the previous fade hadn't moved yet): settle now rather than on a tick.
    if (alpha == target) finish()
  }

  private fun finish() {
    solidOn = target == 1f
    if (target == 0f) mediaOn = false
  }
}
