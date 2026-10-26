package io.virvi.ar.builder

import io.virvi.ar.Quat
import io.virvi.ar.Vec3
import io.virvi.ar.builder.TransformMath.add
import io.virvi.ar.builder.TransformMath.cross
import io.virvi.ar.builder.TransformMath.normalize
import io.virvi.ar.builder.TransformMath.scale
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.sin
import kotlin.math.sqrt

// Sizes from packages/adapter-dcl/src/transform/gizmo.ts and outline.ts.
const val HANDLE_SIZE = 0.12
const val RING_THICKNESS = 0.04
const val RING_MIN_RADIUS = 0.5
const val RING_RADIUS_FACTOR = 0.6
const val RING_SEGMENTS = 32
/** Gap between an item's half-extent (scale / 2) and its handles. */
const val HANDLE_GAP = 0.15
const val HANDLE_MIN_OFFSET = 0.3
const val GUIDE_LENGTH = 40.0
const val GUIDE_THICKNESS = 0.015
const val OUTLINE_THICKNESS = 0.025
/** Gap between the item and its outline, so the edges don't z-fight the item's own faces. */
const val OUTLINE_PAD = 0.03
/** A sound's outline cube (Decentraland's sound marker size). */
const val SOUND_MARKER_SIZE = 0.3

/** What dragging a gizmo part does: [handle] goes to the session; a Move axis handle also sets [lock]. */
data class GizmoGrab(val handle: Handle, val lock: MoveLock = MoveLock.FREE)

/**
 * One box of the gizmo, relative to the item's position: its centre, turn and size. [grab] is null for parts that
 * can't be grabbed (shafts, the lock guide). [color] is the axis colour, or null for white. [inItemFrame] parts are
 * turned with the item (resize handles sit on its own faces, as stretching follows its own axes); the others sit on
 * the scene's axes, as moving and turning do.
 */
data class GizmoPart(
    val grab: GizmoGrab?,
    val color: Axis?,
    val centre: Vec3,
    val rotation: Quat,
    val size: Vec3,
    val inItemFrame: Boolean,
)

/** Images, videos and ad spaces are flat planes: no Z stretch handle, and a frame for an outline. */
fun isFlat(element: String) = element == "image" || element == "video" || element == "ad_space"

/** Ring radius: 0.6 × the largest scale component, at least 0.5 m. */
fun ringRadius(s: Vec3): Double = max(RING_MIN_RADIUS, RING_RADIUS_FACTOR * maxOf(abs(s.x), abs(s.y), abs(s.z)))

/** How far a handle sits from the item's centre along an axis of size [s]. */
fun handleOffset(s: Double): Double = max(HANDLE_MIN_OFFSET, abs(s) / 2 + HANDLE_GAP)

/** Two in-plane basis vectors per ring axis (the ring around X lies in the YZ plane, and so on). */
private fun ringBasis(axis: Axis): Pair<Vec3, Vec3> =
    when (axis) {
      Axis.X -> Axis.Y.unit to Axis.Z.unit
      Axis.Y -> Axis.Z.unit to Axis.X.unit
      Axis.Z -> Axis.X.unit to Axis.Y.unit
    }

/** The turn that takes local x, y, z to [right], [up], [forward] (an orthonormal basis). */
fun basisQuat(right: Vec3, up: Vec3, forward: Vec3): Quat {
  val m00 = right.x
  val m11 = up.y
  val m22 = forward.z
  val trace = m00 + m11 + m22
  return when {
    trace > 0 -> {
      val s = sqrt(trace + 1.0) * 2
      Quat(0.25 * s, (up.z - forward.y) / s, (forward.x - right.z) / s, (right.y - up.x) / s)
    }
    m00 > m11 && m00 > m22 -> {
      val s = sqrt(1.0 + m00 - m11 - m22) * 2
      Quat((up.z - forward.y) / s, 0.25 * s, (up.x + right.y) / s, (forward.x + right.z) / s)
    }
    m11 > m22 -> {
      val s = sqrt(1.0 + m11 - m00 - m22) * 2
      Quat((forward.x - right.z) / s, (up.x + right.y) / s, 0.25 * s, (forward.y + up.z) / s)
    }
    else -> {
      val s = sqrt(1.0 + m22 - m00 - m11) * 2
      Quat((right.y - up.x) / s, (forward.x + right.z) / s, (forward.y + up.z) / s, 0.25 * s)
    }
  }
}

/** Like DCL `Quaternion.lookRotation(forward, up)` (left-handed: right = up × forward). */
fun lookRotation(forward: Vec3, up: Vec3): Quat {
  val f = normalize(forward)
  val r = normalize(cross(up, f))
  return basisQuat(r, cross(f, r), f)
}

private val CUBE = Vec3(HANDLE_SIZE, HANDLE_SIZE, HANDLE_SIZE)

/**
 * The gizmo for [mode] on an item of [scale] and [element] type: three axis handles for Move (each with its shaft,
 * plus a guide line along the locked axis while [lock] isn't free), three rings of [RING_SEGMENTS] boxes for Rotate,
 * and for Resize the corner handle (uniform) and a stretch handle per axis (no Z for flat items), as gizmo.ts.
 */
fun gizmoParts(mode: TransformMode, lock: MoveLock, scale: Vec3, element: String): List<GizmoPart> =
    when (mode) {
      TransformMode.MOVE -> moveParts(lock, scale)
      TransformMode.ROTATE -> Axis.entries.flatMap { ringParts(it, scale) }
      TransformMode.RESIZE -> resizeParts(scale, isFlat(element))
    }

private fun moveParts(lock: MoveLock, s: Vec3): List<GizmoPart> {
  val parts = ArrayList<GizmoPart>()
  for (axis in Axis.entries) {
    val off = handleOffset(s[axis])
    val shaft = Vec3(GUIDE_THICKNESS, GUIDE_THICKNESS, GUIDE_THICKNESS).with(axis, off)
    parts += GizmoPart(null, axis, scale(axis.unit, off / 2), Quat.IDENTITY, shaft, false)
    parts += GizmoPart(GizmoGrab(Handle.Body, MoveLock.entries.first { it.axis == axis }), axis, scale(axis.unit, off), Quat.IDENTITY, CUBE, false)
  }
  lock.axis?.let { axis ->
    val guide = Vec3(GUIDE_THICKNESS, GUIDE_THICKNESS, GUIDE_THICKNESS).with(axis, GUIDE_LENGTH)
    parts += GizmoPart(null, axis, Vec3(0.0, 0.0, 0.0), Quat.IDENTITY, guide, false)
  }
  return parts
}

private fun ringParts(axis: Axis, s: Vec3): List<GizmoPart> {
  val (u, v) = ringBasis(axis)
  val r = ringRadius(s)
  val length = 2 * Math.PI * r / RING_SEGMENTS * 1.1
  return List(RING_SEGMENTS) { i ->
    val theta = (i + 0.5) / RING_SEGMENTS * Math.PI * 2
    val pos = add(scale(u, r * cos(theta)), scale(v, r * sin(theta)))
    val tangent = add(scale(u, -sin(theta)), scale(v, cos(theta)))
    GizmoPart(GizmoGrab(Handle.Ring(axis)), axis, pos, lookRotation(tangent, axis.unit), Vec3(RING_THICKNESS, RING_THICKNESS, length), false)
  }
}

private fun resizeParts(s: Vec3, flat: Boolean): List<GizmoPart> {
  val corner = Vec3(handleOffset(s.x), handleOffset(s.y), handleOffset(s.z))
  val parts = arrayListOf(GizmoPart(GizmoGrab(Handle.Uniform), null, corner, Quat.IDENTITY, CUBE, true))
  for (axis in Axis.entries) {
    if (flat && axis == Axis.Z) continue
    parts += GizmoPart(GizmoGrab(Handle.Stretch(axis)), axis, scale(axis.unit, handleOffset(s[axis])), Quat.IDENTITY, CUBE, true)
  }
  return parts
}

/** One edge of the picked item's outline, in the item's own (turned) frame: its centre and size. */
data class OutlineEdge(val centre: Vec3, val size: Vec3)

/**
 * The picked item's outline (outline.ts): the edges of its box, a frame for flat items. A model's box rises from its
 * origin (models sit on their base); a sound gets a [SOUND_MARKER_SIZE] cube.
 */
fun outlineEdges(element: String, s: Vec3): List<OutlineEdge> {
  val ax = abs(s.x)
  val ay = abs(s.y)
  val az = abs(s.z)
  val flat = isFlat(element)
  val (half, center) =
      when {
        element == "sound" -> (SOUND_MARKER_SIZE / 2 + OUTLINE_PAD).let { h -> Vec3(h, h, h) to Vec3(0.0, 0.0, 0.0) }
        flat -> Vec3(ax / 2 + OUTLINE_PAD, ay / 2 + OUTLINE_PAD, 0.0) to Vec3(0.0, 0.0, 0.0)
        else -> Vec3(ax / 2 + OUTLINE_PAD, ay / 2 + OUTLINE_PAD, az / 2 + OUTLINE_PAD) to Vec3(0.0, ay / 2, 0.0)
      }
  fun edge(along: Axis, sx: Int, sy: Int, sz: Int) =
      OutlineEdge(
          Vec3(center.x + sx * half.x, center.y + sy * half.y, center.z + sz * half.z),
          Vec3(OUTLINE_THICKNESS, OUTLINE_THICKNESS, OUTLINE_THICKNESS).with(along, half[along] * 2 + OUTLINE_THICKNESS),
      )
  val signs = listOf(-1, 1)
  if (flat) return signs.map { edge(Axis.X, 0, it, 0) } + signs.map { edge(Axis.Y, it, 0, 0) }
  return signs.flatMap { a -> signs.flatMap { b -> listOf(edge(Axis.X, 0, a, b), edge(Axis.Y, a, 0, b), edge(Axis.Z, a, b, 0)) } }
}
