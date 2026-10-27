package io.virvi.ar.visitor

import android.net.Uri
import com.meta.spatial.core.Color4
import com.meta.spatial.core.Entity
import com.meta.spatial.core.Pose
import com.meta.spatial.core.Vector3
import com.meta.spatial.toolkit.Box
import com.meta.spatial.toolkit.Material
import com.meta.spatial.toolkit.Mesh
import com.meta.spatial.toolkit.MeshCollision
import com.meta.spatial.toolkit.Transform
import com.meta.spatial.toolkit.TransformParent
import io.virvi.ar.Quat
import io.virvi.ar.Vec3
import io.virvi.ar.sdk
import io.virvi.ar.space.OutlineView
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

const val OUTLINE_THICKNESS_M = 0.004
const val OUTLINE_SEGMENTS = 48
const val OUTLINE_SHOW_MS = 1200L

/** One short box of the outline, in the ring's plane (x right, y up, z out of the wall): its centre and turn about z. */
data class OutlineSegment(val centre: Vec3, val angleRad: Double, val lengthM: Double)

/** [count] boxes laid round a ring of printed diameter [diameterM], just outside its edge, overlapping slightly. */
fun outlineSegments(diameterM: Double, count: Int = OUTLINE_SEGMENTS): List<OutlineSegment> {
  val r = diameterM / 2 + OUTLINE_THICKNESS_M / 2
  val length = 2 * PI * r / count * 1.1
  return List(count) { i ->
    val a = 2 * PI * i / count
    OutlineSegment(Vec3(r * cos(a), r * sin(a), 0.0), a, length)
  }
}

/**
 * The thin cyan ring flashed on a ring marker when the scene locks on: 48 boxes, 4 mm thick, the marker's printed
 * diameter, facing the marker's heading, shown for [OUTLINE_SHOW_MS]. Main thread only.
 */
class RingOutline : OutlineView {
  private var entities: List<Entity> = emptyList()
  private var hideAt = 0L

  /** Shows the outline at [world] facing [headingDeg] (degrees from +Z toward +X, into the room). */
  override fun flash(world: Vec3, headingDeg: Double, diameterM: Double, nowMs: Long) {
    clear()
    val turn = Quat.axisAngle(0.0, 1.0, 0.0, Math.toRadians(headingDeg))
    // A few millimetres off the wall, so the outline isn't lost in it.
    val out = turn.rotate(Vec3(0.0, 0.0, 0.005))
    val root =
        Entity.create(
            listOf(Transform(Pose(Vec3(world.x + out.x, world.y + out.y, world.z + out.z).sdk(), turn.sdk())))
        )
    val half = (OUTLINE_THICKNESS_M / 2).toFloat()
    val parts =
        outlineSegments(diameterM).map { s ->
          val l = (s.lengthM / 2).toFloat()
          Entity.create(
              listOf(
                  Mesh(Uri.parse("mesh://box"), hittable = MeshCollision.NoCollision),
                  // x radial, y along the ring
                  Box(Vector3(-half, -l, -half), Vector3(half, l, half)),
                  Material(baseColor = Color4(0.2f, 0.95f, 1f, 1f), unlit = true),
                  TransformParent(root),
                  Transform(Pose(s.centre.sdk(), Quat.axisAngle(0.0, 0.0, 1.0, s.angleRad).sdk())),
              )
          )
        }
    entities = listOf(root) + parts
    hideAt = nowMs + OUTLINE_SHOW_MS
  }

  override fun tick(nowMs: Long) {
    if (entities.isNotEmpty() && nowMs >= hideAt) clear()
  }

  override fun clear() {
    entities.asReversed().forEach { it.destroy() }
    entities = emptyList()
  }
}
