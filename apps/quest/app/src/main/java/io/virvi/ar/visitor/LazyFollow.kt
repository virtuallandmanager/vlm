package io.virvi.ar.visitor

import io.virvi.ar.Vec3
import io.virvi.ar.space.angleDiffDeg
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.sin

/** A panel's place: its centre, and the way it faces (degrees from +Z toward +X, the viewer's heading). */
data class CardPose(val position: Vec3, val yawDeg: Double)

/**
 * Keeps a card [distanceM] ahead of the head and [dropM] below the eyes, lazily: it stays put until it is more than
 * [turnDeg] off to the side of where the head points, or the head has walked more than [driftM] nearer or further
 * from it, and then eases to the new place over [easeMs]. Main thread only.
 */
class LazyFollow(
    private val distanceM: Double = 1.0,
    private val dropM: Double = 0.15,
    private val turnDeg: Double = 35.0,
    private val driftM: Double = 0.5,
    private val easeMs: Long = 300,
) {
  private var from: CardPose? = null
  private var to: CardPose? = null
  private var easeStart = 0L

  fun update(head: Vec3, headYawDeg: Double, nowMs: Long): CardPose {
    val target = to
    if (target == null) {
      return ahead(head, headYawDeg).also {
        from = it
        to = it
      }
    }
    val current = at(nowMs)
    val toCard = Math.toDegrees(atan2(target.position.x - head.x, target.position.z - head.z))
    val dist = hypot(target.position.x - head.x, target.position.z - head.z)
    if (abs(angleDiffDeg(toCard, headYawDeg)) > turnDeg || abs(dist - distanceM) > driftM) {
      from = current
      to = ahead(head, headYawDeg)
      easeStart = nowMs
      return current
    }
    return current
  }

  /** The next [update] puts the card straight ahead, without easing. */
  fun recentre() {
    from = null
    to = null
  }

  private fun at(nowMs: Long): CardPose {
    val a = from!!
    val b = to!!
    val t = ((nowMs - easeStart).toDouble() / easeMs).coerceIn(0.0, 1.0)
    if (t >= 1.0) return b.also { from = it }
    val k = t * t * (3 - 2 * t) // smoothstep
    fun mix(p: Double, q: Double) = p + (q - p) * k
    return CardPose(
        Vec3(mix(a.position.x, b.position.x), mix(a.position.y, b.position.y), mix(a.position.z, b.position.z)),
        a.yawDeg + angleDiffDeg(b.yawDeg, a.yawDeg) * k,
    )
  }

  private fun ahead(head: Vec3, yawDeg: Double): CardPose {
    val r = Math.toRadians(yawDeg)
    return CardPose(Vec3(head.x + sin(r) * distanceM, head.y - dropM, head.z + cos(r) * distanceM), yawDeg)
  }
}
