package io.virvi.ar.builder

import io.virvi.ar.Quat
import io.virvi.ar.Vec3
import io.virvi.ar.builder.TransformMath.add
import io.virvi.ar.builder.TransformMath.angleOnRing
import io.virvi.ar.builder.TransformMath.closestPointOnAxis
import io.virvi.ar.builder.TransformMath.dot
import io.virvi.ar.builder.TransformMath.eulerDegreesToQuat
import io.virvi.ar.builder.TransformMath.length
import io.virvi.ar.builder.TransformMath.quatFromAxisAngle
import io.virvi.ar.builder.TransformMath.quatMultiply
import io.virvi.ar.builder.TransformMath.quatToEulerDegrees
import io.virvi.ar.builder.TransformMath.rayPlane
import io.virvi.ar.builder.TransformMath.rotateVector
import io.virvi.ar.builder.TransformMath.sameTransform
import io.virvi.ar.builder.TransformMath.scale
import io.virvi.ar.builder.TransformMath.snap
import io.virvi.ar.builder.TransformMath.sub
import io.virvi.ar.builder.TransformMath.wrap180
import kotlin.math.abs
import kotlin.math.max

enum class TransformMode { MOVE, ROTATE, RESIZE }

enum class MoveLock(val axis: Axis?) {
  FREE(null),
  X(Axis.X),
  Y(Axis.Y),
  Z(Axis.Z),
}

/** What the ray grabbed: the item itself (Move), a ring (Rotate), the corner (uniform Resize) or a face (stretch). */
sealed interface Handle {
  data object Body : Handle

  data class Ring(val axis: Axis) : Handle

  data object Uniform : Handle

  data class Stretch(val axis: Axis) : Handle
}

/** [element] is the element type: image, video, model, sound or ad_space. [sk] is the instance's sk. */
data class Selected(val element: String, val sk: String, val name: String, val transform: ItemTransform)

data class DraftPayload(val element: String, val sk: String, val transform: ItemTransform)

enum class SelectResult { OK, DIRTY }

// session.ts constants, as they are.
const val DEFAULT_DRAFT_INTERVAL_MS = 100L
/** Computed points farther than this from the ray origin are treated as misses. */
const val MAX_HIT_DISTANCE = 50.0
const val MIN_GRAB_DISTANCE = 0.01
const val MIN_SCALE = 0.05
const val ROTATE_SNAP_DEGREES = 15.0
const val UNIFORM_SNAP_STEP = 0.1
const val STRETCH_SNAP_STEP = 0.25

/**
 * Port of packages/core/src/transform/session.ts: the platform-free edit session behind the builder's Move /
 * Rotate / Resize bar. The headset feeds it pointer rays in scene coordinates every frame; it hands out drafts through
 * [onDraft] at most every [draftIntervalMs] while dragging (and once more when a drag ends). Scale never goes below
 * [MIN_SCALE]. Kotlin's [ItemTransform] is immutable, so the copies session.ts makes aren't needed.
 *
 * Two additions: [setLock], so the gizmo's axis handles can choose the lock directly, and [cancelDrag], which ends a
 * drag without flushing it.
 */
class TransformSession(
    private val now: () -> Long,
    private val onDraft: (DraftPayload) -> Unit,
    private val draftIntervalMs: Long = DEFAULT_DRAFT_INTERVAL_MS,
) {
  var selected: Selected? = null
    private set

  private var baseline: ItemTransform? = null

  var draft: ItemTransform? = null
    private set

  var mode: TransformMode = TransformMode.MOVE
    private set

  var lock: MoveLock = MoveLock.FREE
    private set

  private var snapOn = false

  private var handle: Handle? = null
  private var dragState: DragState? = null
  /** Lock the active move drag was started with; a change triggers a rebase. */
  private var dragLock: MoveLock = MoveLock.FREE
  private var emittedThisDrag = false
  private var lastEmit = 0L
  /** What the network last saw this drag (the drag-start transform until the first emit). */
  private var lastSent: ItemTransform? = null

  val dirty: Boolean
    get() {
      val d = draft ?: return false
      val b = baseline ?: return false
      return !sameTransform(d, b)
    }

  /** True while a handle is held. */
  val dragging: Boolean
    get() = dragState != null

  fun select(item: Selected): SelectResult {
    if (dirty) return SelectResult.DIRTY
    selected = item
    baseline = item.transform
    draft = item.transform
    resetDrag()
    return SelectResult.OK
  }

  fun setMode(m: TransformMode) {
    mode = m
    flushIfChanged()
    resetDrag()
  }

  fun cycleLock(): MoveLock {
    val all = MoveLock.entries
    lock = all[(all.indexOf(lock) + 1) % all.size]
    return lock
  }

  /** Not in session.ts: the gizmo's axis handles set the lock directly (a drag in progress rebases, as on a cycle). */
  fun setLock(l: MoveLock) {
    lock = l
  }

  fun setSnap(on: Boolean) {
    snapOn = on
  }

  /** [surfaceHit] is unused: free move uses no grab offset, so the begin-time hit is not needed. */
  @Suppress("UNUSED_PARAMETER")
  fun beginDrag(handle: Handle, ray: Ray, surfaceHit: Vec3?) {
    val d = draft ?: return
    if (!handleFitsMode(handle)) return
    this.handle = handle
    emittedThisDrag = false
    lastSent = d
    startFrom(d, ray)
  }

  fun drag(ray: Ray, surfaceHit: Vec3?) {
    val d = draft ?: return
    if (selected == null || handle == null) return
    val state = dragState ?: return
    if ((state is DragState.MoveFree || state is DragState.MoveAxis) && dragLock != lock) startFrom(d, ray)
    val next = compute(dragState!!, ray, surfaceHit) ?: return
    update(d, next)
  }

  /** Not in session.ts: starts carrying the item with a controller (see [carryTo]); [dragging] until it ends. */
  fun beginCarry() {
    val d = draft ?: return
    if (dragState != null) return
    handle = Handle.Body
    emittedThisDrag = false
    lastSent = d
    dragState = DragState.Carried(d)
  }

  /** Not in session.ts: the carried item's new [t] this frame, drafted like a drag's (at most every interval). */
  fun carryTo(t: ItemTransform) {
    val d = draft ?: return
    if (dragState !is DragState.Carried) return
    update(d, t)
  }

  /** Makes [next] the draft and emits it unless one went out less than an interval ago. */
  private fun update(d: ItemTransform, next: ItemTransform) {
    if (sameTransform(next, d)) return
    draft = next
    val t = now()
    if (!emittedThisDrag || t - lastEmit >= draftIntervalMs) {
      emittedThisDrag = true
      lastEmit = t
      emit()
    }
  }

  /**
   * Sets one axis of the current mode's value (position in metres, rotation in degrees, scale floored at 0.05), as
   * typed into the HUD. Ends any drag first so the next frame doesn't overwrite it. False when nothing is selected or
   * the value isn't a finite number.
   */
  fun setValue(axis: Axis, value: Double): Boolean {
    val d = draft ?: return false
    if (selected == null || !value.isFinite()) return false
    resetDrag()
    val next =
        when (mode) {
          TransformMode.MOVE -> d.copy(position = d.position.with(axis, value))
          TransformMode.ROTATE -> d.copy(rotation = d.rotation.with(axis, value))
          TransformMode.RESIZE -> d.copy(scale = d.scale.with(axis, max(MIN_SCALE, value)))
        }
    if (sameTransform(next, d)) return true
    draft = next
    lastEmit = now()
    emit()
    return true
  }

  /** Sends the draft unless the network already has it. */
  private fun flushIfChanged() {
    if (dragState == null) return
    val d = draft ?: return
    val sent = lastSent
    if (sent != null && sameTransform(d, sent)) return
    lastEmit = now()
    emit()
  }

  fun endDrag() {
    if (dragState == null) return
    flushIfChanged()
    resetDrag()
  }

  /** Not in session.ts: drops the drag without sending its unsent frame (the edit is being reverted or abandoned). */
  fun cancelDrag() {
    resetDrag()
  }

  fun takeSave(): DraftPayload? {
    val s = selected ?: return null
    val d = draft ?: return null
    if (!dirty) return null
    baseline = d
    selected = s.copy(transform = d)
    return DraftPayload(s.element, s.sk, d)
  }

  fun revert(): ItemTransform? {
    val b = baseline ?: return null
    draft = b
    resetDrag()
    return b
  }

  fun clear() {
    selected = null
    baseline = null
    draft = null
    lock = MoveLock.FREE
    dragLock = MoveLock.FREE
    resetDrag()
  }

  private fun resetDrag() {
    handle = null
    dragState = null
    emittedThisDrag = false
    lastSent = null
  }

  private fun emit() {
    val s = selected ?: return
    val d = draft ?: return
    lastSent = d
    onDraft(DraftPayload(s.element, s.sk, d))
  }

  private fun handleFitsMode(h: Handle): Boolean =
      when (mode) {
        TransformMode.MOVE -> h is Handle.Body
        TransformMode.ROTATE -> h is Handle.Ring
        TransformMode.RESIZE -> h is Handle.Uniform || h is Handle.Stretch
      }

  private sealed interface DragState {
    val start: ItemTransform

    class MoveFree(override val start: ItemTransform) : DragState

    /** A controller carries the item; its poses come through [carryTo], not rays. */
    class Carried(override val start: ItemTransform) : DragState

    /** A null [grab] is retried next frame. */
    class MoveAxis(override val start: ItemTransform, val axis: Axis, var grab: Vec3?) : DragState

    class Rotate(
        override val start: ItemTransform,
        val axis: Axis,
        val startQuat: Quat,
        var lastAngle: Double?,
        var total: Double,
    ) : DragState

    class Uniform(override val start: ItemTransform, val normal: Vec3, val grabDistance: Double?) : DragState

    /** [dir] is the item's own (rotated) axis: stretching follows the item, not the scene. */
    class Stretch(override val start: ItemTransform, val axis: Axis, val dir: Vec3, val grabDistance: Double?) : DragState
  }

  /** Captures drag-start data from [from] and the ray that grabbed the handle. */
  private fun startFrom(from: ItemTransform, ray: Ray) {
    val pos = from.position
    dragState =
        when (val h = handle!!) {
          Handle.Body -> {
            dragLock = lock
            val axis = lock.axis
            if (axis == null) DragState.MoveFree(from) else DragState.MoveAxis(from, axis, axisHit(ray, pos, axis))
          }
          is Handle.Ring -> {
            val n = h.axis.unit
            val lastAngle = if (planeHit(ray, pos, n) != null) angleOnRing(ray, pos, n) else null
            DragState.Rotate(from, h.axis, eulerDegreesToQuat(from.rotation), lastAngle, 0.0)
          }
          Handle.Uniform -> {
            val normal = scale(ray.direction, -1.0)
            val grab = planeHit(ray, pos, normal)
            val dist = if (grab != null) length(sub(grab, pos)) else 0.0
            DragState.Uniform(from, normal, if (dist >= MIN_GRAB_DISTANCE) dist else null)
          }
          is Handle.Stretch -> {
            val dir = rotateVector(eulerDegreesToQuat(from.rotation), h.axis.unit)
            val grab = lineHit(ray, pos, dir)
            val d = if (grab != null) abs(dot(sub(grab, pos), dir)) else 0.0
            DragState.Stretch(from, h.axis, dir, if (d >= MIN_GRAB_DISTANCE) d else null)
          }
        }
  }

  /** The new draft for this frame, or null when the frame can't be evaluated (draft stays as it is). */
  private fun compute(state: DragState, ray: Ray, surfaceHit: Vec3?): ItemTransform? {
    val start = state.start
    return when (state) {
      is DragState.Carried -> null
      is DragState.MoveFree -> {
        val hit = near(ray, surfaceHit) ?: planeHit(ray, start.position, UP) ?: return null
        start.copy(position = hit)
      }
      is DragState.MoveAxis -> {
        val now = axisHit(ray, start.position, state.axis)
        val grab = state.grab
        if (grab == null) {
          state.grab = now // grab couldn't be resolved earlier; use this frame as the grab, no movement yet
          return null
        }
        if (now == null) return null
        val along = dot(sub(now, grab), state.axis.unit)
        start.copy(position = add(start.position, scale(state.axis.unit, along)))
      }
      is DragState.Rotate -> {
        val axisVec = state.axis.unit
        val angle = (if (planeHit(ray, start.position, axisVec) != null) angleOnRing(ray, start.position, axisVec) else null) ?: return null
        state.lastAngle?.let { state.total += wrap180(angle - it) }
        state.lastAngle = angle
        val delta = if (snapOn) snap(state.total, ROTATE_SNAP_DEGREES) else state.total
        // No net rotation: keep the exact start Euler (the quaternion round trip wraps angles and zeroes z at the poles).
        start.copy(
            rotation =
                if (abs(delta) < 1e-6) start.rotation
                else quatToEulerDegrees(quatMultiply(quatFromAxisAngle(axisVec, delta), state.startQuat))
        )
      }
      is DragState.Uniform -> {
        val grabDistance = state.grabDistance ?: return null
        val hit = planeHit(ray, start.position, state.normal) ?: return null
        var factor = length(sub(hit, start.position)) / grabDistance
        if (snapOn) factor = max(UNIFORM_SNAP_STEP, snap(factor, UNIFORM_SNAP_STEP))
        start.copy(scale = floorScale(scale(start.scale, factor)))
      }
      is DragState.Stretch -> {
        val grabDistance = state.grabDistance ?: return null
        val hit = lineHit(ray, start.position, state.dir) ?: return null
        val factor = abs(dot(sub(hit, start.position), state.dir)) / grabDistance
        val from = start.scale[state.axis]
        var size = abs(from) * factor
        if (snapOn) size = max(STRETCH_SNAP_STEP, snap(size, STRETCH_SNAP_STEP))
        start.copy(scale = start.scale.with(state.axis, floorMagnitude(size, from)))
      }
    }
  }

  private companion object {
    val UP = Vec3(0.0, 1.0, 0.0)

    fun floorScale(v: Vec3) = Vec3(floorMagnitude(abs(v.x), v.x), floorMagnitude(abs(v.y), v.y), floorMagnitude(abs(v.z), v.z))

    /** [magnitude] floored at [MIN_SCALE], with the sign of [like] (a mirrored axis stays mirrored; zero is positive). */
    fun floorMagnitude(magnitude: Double, like: Double): Double =
        max(MIN_SCALE, magnitude).let { if (like < 0) -it else it }

    /** Null when the point is missing or implausibly far from the ray origin (near-parallel solves blow up). */
    fun near(ray: Ray, point: Vec3?): Vec3? {
      if (point == null) return null
      return if (length(sub(point, ray.origin)) > MAX_HIT_DISTANCE) null else point
    }

    fun planeHit(ray: Ray, point: Vec3, normal: Vec3): Vec3? = near(ray, rayPlane(ray, point, normal))

    fun axisHit(ray: Ray, point: Vec3, axis: Axis): Vec3? = lineHit(ray, point, axis.unit)

    fun lineHit(ray: Ray, point: Vec3, dir: Vec3): Vec3? = near(ray, closestPointOnAxis(ray, point, dir))
  }
}
