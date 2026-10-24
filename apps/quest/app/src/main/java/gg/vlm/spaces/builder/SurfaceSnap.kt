package gg.vlm.spaces.builder

import gg.vlm.spaces.Vec3
import gg.vlm.spaces.builder.TransformMath.cross
import gg.vlm.spaces.builder.TransformMath.dot
import gg.vlm.spaces.builder.TransformMath.normalize
import gg.vlm.spaces.builder.TransformMath.scale
import gg.vlm.spaces.builder.TransformMath.sub
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.max

enum class SurfaceKind { WALL, FLOOR, TABLE }

/**
 * A real flat surface from the room scan, in world space: its [centre], unit [normal] (a wall's points into the room;
 * a floor's or table's is up) and half extents. [widthAxis] is the unit direction of [halfWidth] in the plane; when
 * null, a wall's runs level along it and a floor's or table's along +X, with [halfHeight] across.
 */
data class Surface(
    val kind: SurfaceKind,
    val centre: Vec3,
    val normal: Vec3,
    val halfWidth: Double,
    val halfHeight: Double,
    val widthAxis: Vec3? = null,
)

/** An item within this distance of a surface (its nearest face, not its middle) snaps to it. */
const val SNAP_DISTANCE_M = 0.15

/** How thin a flat item (image, video, ad space) is when it lies against a wall. */
const val FLAT_HALF_DEPTH_M = 0.01

data class SnapResult(val position: Vec3, val yawDeg: Double, val snappedTo: SurfaceKind?)

/** How far an item reaches from its position: [halfDepth] along its facing, [halfHeight] down to its underside. */
data class SnapExtents(val halfDepth: Double, val halfHeight: Double)

private val UP = Vec3(0.0, 1.0, 0.0)

/**
 * A [Surface] from room-scan plane data (all in world space): [widthAxis] is the plane's own x axis. A floor or table
 * always faces up, whatever way the scan's plane points.
 */
fun surfaceOf(kind: SurfaceKind, centre: Vec3, normal: Vec3, widthAxis: Vec3, halfWidth: Double, halfHeight: Double) =
    Surface(kind, centre, if (kind == SurfaceKind.WALL) normalize(normal) else UP, halfWidth, halfHeight, normalize(widthAxis))

/**
 * What an item of this [element] at scale [s] reaches: flat items are centred and thin; a model rests on its origin
 * (so nothing below it) and is as deep as its scale says; a sound is its marker cube.
 */
fun snapExtents(element: String, s: Vec3): SnapExtents =
    when {
      isFlat(element) -> SnapExtents(FLAT_HALF_DEPTH_M, abs(s.y) / 2)
      element == "sound" -> SnapExtents(SOUND_MARKER_SIZE / 2, SOUND_MARKER_SIZE / 2)
      else -> SnapExtents(abs(s.z) / 2, 0.0)
    }

/**
 * Where an item put down at [position] ([yawDeg] its heading) should sit against the room: flush on a wall, resting on
 * a floor or table. All in world space. Only surfaces whose plane is within [SNAP_DISTANCE_M] of the item (its back
 * face against a wall, its underside over a floor or table) and whose rectangle contains the item's projection count,
 * and the nearest wins. A wall's distance counts either side of the plane, so an item up to that far behind a wall
 * (pushed through it) comes out to the wall's front face. A wall puts the item [halfDepthM] off the plane along its normal and turns it to face along
 * that normal (headings run from +Z toward +X); a floor or table sets the height to the surface plus [halfHeightM]
 * and leaves the heading.
 */
fun snap(position: Vec3, yawDeg: Double, halfDepthM: Double, halfHeightM: Double, surfaces: List<Surface>): SnapResult {
  var best: Candidate? = null
  for (s in surfaces) {
    val c = candidate(s, position, halfDepthM, halfHeightM) ?: continue
    val b = best
    if (b == null || c.gap < b.gap || (c.gap == b.gap && c.plane < b.plane)) best = c
  }
  val c = best ?: return SnapResult(position, yawDeg, null)
  val s = c.surface
  return when (s.kind) {
    SurfaceKind.WALL -> {
      val n = normalize(s.normal)
      val onPlane = sub(position, scale(n, dot(sub(position, s.centre), n)))
      val heading = Math.toDegrees(atan2(n.x, n.z))
      SnapResult(
          Vec3(onPlane.x + n.x * halfDepthM, onPlane.y + n.y * halfDepthM, onPlane.z + n.z * halfDepthM),
          (heading + 360.0) % 360.0,
          s.kind,
      )
    }
    SurfaceKind.FLOOR,
    SurfaceKind.TABLE -> SnapResult(position.copy(y = s.centre.y + halfHeightM), yawDeg, s.kind)
  }
}

/** A surface the item could snap to: [gap] is how far the item's nearest face is from it, [plane] its middle's. */
private class Candidate(val surface: Surface, val gap: Double, val plane: Double)

/** [surface] as a snap candidate for the item, or null when it is too far or the item is off its rectangle. */
private fun candidate(surface: Surface, p: Vec3, halfDepth: Double, halfHeight: Double): Candidate? {
  val wall = surface.kind == SurfaceKind.WALL
  val n = if (wall) normalize(surface.normal) else UP
  if (dot(n, n) == 0.0) return null
  val d = sub(p, surface.centre)
  val off = dot(d, n)
  // The item's nearest face to the plane: its back against a wall, its underside over a floor.
  val gap = if (wall) max(0.0, abs(off) - halfDepth) else abs(off - halfHeight)
  if (gap > SNAP_DISTANCE_M) return null
  val width = surface.widthAxis?.let(::normalize) ?: defaultWidthAxis(wall, n) ?: return null
  val across = normalize(cross(n, width))
  if (abs(dot(d, width)) > surface.halfWidth || abs(dot(d, across)) > surface.halfHeight) return null
  return Candidate(surface, gap, abs(off))
}

/** A wall's level direction along itself, else +X; null for a wall lying flat (no such direction). */
private fun defaultWidthAxis(wall: Boolean, n: Vec3): Vec3? {
  if (!wall) return Vec3(1.0, 0.0, 0.0)
  val w = cross(UP, n)
  return if (dot(w, w) < 1e-12) null else normalize(w)
}
