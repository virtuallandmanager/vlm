package gg.vlm.spaces.builder

import gg.vlm.spaces.Vec3
import kotlin.math.abs

/** An item's place in the scene: scene coordinates, rotation in degrees. */
data class ItemTransform(val position: Vec3, val rotation: Vec3, val scale: Vec3)

/** packages/shared `Adjustment`: this place's offset from the shared transform. */
data class Adjustment(val dPosition: Vec3, val dRotation: Vec3, val scaleFactor: Vec3)

enum class Scope {
  /** Moves the shared transform, so every place gets the move. */
  EVERYWHERE,
  /** Saves an adjustment for this place only. */
  JUST_HERE,
}

/** What Save (or Revert) asks the server to do for one draft. */
sealed interface SaveOp {
  val sk: String

  data class UpdateInstance(override val sk: String, val transform: ItemTransform) : SaveOp
  data class PutAdjustment(override val sk: String, val adjustment: Adjustment) : SaveOp
  /** Clears this place's adjustment: a "Just this place" edit that ended where the shared transform is. */
  data class DeleteAdjustment(override val sk: String) : SaveOp
  data class EndDraft(override val sk: String, val saved: Boolean) : SaveOp
}

/**
 * The builder's unsaved edits, one per item ([Draft.sk], the instance's sk). Nothing reaches the server until
 * [saveOps] are run; [saveOps] does not forget the drafts, so a failed save can be tried again: the caller calls
 * [forget] for each one the server took.
 */
class DraftStore(private val clock: () -> Long) {
  data class Draft(
      /** The instance's sk. */
      val sk: String,
      /** The element type: image, video, model, sound or ad_space (not the element's id). */
      val element: String,
      /** The shared (unadjusted) transform. */
      val base: ItemTransform,
      /** The feed's `arAdjustment`: this place's offset when the edit began, or null when it has none. */
      val adjustment: Adjustment?,
      /** What the builder sees: shared plus this place's adjustment, plus their edit. */
      val now: ItemTransform,
      val scope: Scope,
      val editedAtMs: Long,
  ) {
    /**
     * The shared transform this draft would leave, which is what live drafts relay to Decentraland editors: [now]
     * with this place's adjustment taken back out (Everywhere), or the untouched [base] (Just this place, which
     * doesn't move the shared scene).
     */
    val sharedNow: ItemTransform
      get() =
          when (scope) {
            Scope.EVERYWHERE -> shared(now, adjustment)
            Scope.JUST_HERE -> base
          }
  }

  private val byKey = LinkedHashMap<String, Draft>()

  /**
   * Records or updates the draft of [sk]. [element] is the element type (image, video, model, sound or ad_space).
   * [base] is the shared transform: the feed's `arShared` for an instance with `arAdjusted: true`, else the
   * instance's own. [adjustment] is the feed's `arAdjustment` (null when none). [now] is what the builder sees.
   */
  @Synchronized
  fun edit(sk: String, element: String, base: ItemTransform, adjustment: Adjustment?, now: ItemTransform, scope: Scope) {
    byKey[sk] = Draft(sk, element, base, adjustment, now, scope, clock())
  }

  @Synchronized fun drafts(): List<Draft> = byKey.values.toList()

  @Synchronized fun draft(sk: String): Draft? = byKey[sk]

  @Synchronized
  fun saveOps(): List<SaveOp> =
      byKey.values.flatMap { d ->
        when (d.scope) {
          Scope.EVERYWHERE -> listOf(SaveOp.UpdateInstance(d.sk, d.sharedNow), SaveOp.EndDraft(d.sk, true))
          // The server ends this headset's draft when it saves or clears the adjustment.
          Scope.JUST_HERE ->
              when {
                !TransformMath.sameTransform(d.now, d.base) -> listOf(SaveOp.PutAdjustment(d.sk, offset(d.base, d.now)))
                d.adjustment != null -> listOf(SaveOp.DeleteAdjustment(d.sk))
                // Back where it started with nothing to clear: only the draft to end.
                else -> listOf(SaveOp.EndDraft(d.sk, false))
              }
        }
      }

  /** Ends every draft unsaved and forgets them all. */
  @Synchronized
  fun revert(): List<SaveOp> {
    val ops = byKey.keys.map { SaveOp.EndDraft(it, false) }
    clear()
    return ops
  }

  /** Forgets [sk]'s draft (its save went through). */
  @Synchronized
  fun forget(sk: String) {
    byKey.remove(sk)
  }

  /** Forgets drafts whose item left the feed (deleted by someone else) and returns their unsaved draft ends. */
  @Synchronized
  fun dropMissing(present: Set<String>): List<SaveOp> = endAll(byKey.keys.filter { it !in present })

  /** Forgets drafts not edited for more than [olderThanMs] and returns their unsaved draft ends. */
  @Synchronized
  fun expire(olderThanMs: Long): List<SaveOp> {
    val t = clock()
    return endAll(byKey.values.filter { t - it.editedAtMs > olderThanMs }.map { it.sk })
  }

  private fun endAll(sks: List<String>): List<SaveOp> {
    sks.forEach(::forget)
    return sks.map { SaveOp.EndDraft(it, false) }
  }

  private fun clear() {
    byKey.clear()
  }

  private companion object {
    /** [now] with the adjustment taken back out; without one, [now] itself. */
    fun shared(now: ItemTransform, adj: Adjustment?): ItemTransform =
        if (adj == null) now
        else
            ItemTransform(
                Vec3(now.position.x - adj.dPosition.x, now.position.y - adj.dPosition.y, now.position.z - adj.dPosition.z),
                Vec3(now.rotation.x - adj.dRotation.x, now.rotation.y - adj.dRotation.y, now.rotation.z - adj.dRotation.z),
                Vec3(div(now.scale.x, adj.scaleFactor.x), div(now.scale.y, adj.scaleFactor.y), div(now.scale.z, adj.scaleFactor.z)),
            )

    /** The full offset of [now] from [base] (never an increment on an earlier adjustment). */
    fun offset(base: ItemTransform, now: ItemTransform) =
        Adjustment(
            Vec3(now.position.x - base.position.x, now.position.y - base.position.y, now.position.z - base.position.z),
            Vec3(now.rotation.x - base.rotation.x, now.rotation.y - base.rotation.y, now.rotation.z - base.rotation.z),
            Vec3(ratio(now.scale.x, base.scale.x), ratio(now.scale.y, base.scale.y), ratio(now.scale.z, base.scale.z)),
        )

    /**
     * A zero base component gives factor 1. Sizes are compared without their sign, so a mirrored (negative) shared
     * scale keeps its mirror in the shared transform and the factor stays positive, as the server requires.
     */
    fun ratio(now: Double, base: Double) = if (base == 0.0) 1.0 else abs(now) / abs(base)

    /** A zero factor can't be taken back out; the component is left as it is. */
    fun div(v: Double, factor: Double) = if (factor == 0.0) v else v / factor
  }
}
