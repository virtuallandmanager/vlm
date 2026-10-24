package gg.vlm.spaces.builder

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
import gg.vlm.spaces.Quat
import gg.vlm.spaces.Vec3
import gg.vlm.spaces.sdk

private val AXIS_COLORS =
    mapOf(
        Axis.X to Color4(0.95f, 0.2f, 0.2f, 1f),
        Axis.Y to Color4(0.2f, 0.85f, 0.3f, 1f),
        Axis.Z to Color4(0.25f, 0.45f, 1f, 1f),
    )
private val WHITE = Color4(1f, 1f, 1f, 1f)
private val OUTLINE_COLOR = Color4(1f, 0.85f, 0.2f, 1f)

private fun r3(v: Vec3) = "${Math.round(v.x * 1000)},${Math.round(v.y * 1000)},${Math.round(v.z * 1000)}"

/** An unlit box of [size] centred at [centre] (turned [rotation]) under [parent]; grabbable boxes take ray hits. */
private fun box(parent: Entity, centre: Vec3, rotation: Quat, size: Vec3, color: Color4, hittable: Boolean): Entity {
  val h = Vector3((size.x / 2).toFloat(), (size.y / 2).toFloat(), (size.z / 2).toFloat())
  return Entity.create(
      listOf(
          Mesh(Uri.parse("mesh://box"), hittable = if (hittable) MeshCollision.LineTest else MeshCollision.NoCollision),
          Box(Vector3(-h.x, -h.y, -h.z), h),
          Material(baseColor = color, unlit = true),
          TransformParent(parent),
          Transform(Pose(centre.sdk(), rotation.sdk())),
      )
  )
}

/** A root under [parent] at the item's position, and a child of it turned with the item. */
private class ItemFrame(parent: Entity) {
  val root: Entity = Entity.create(listOf(TransformParent(parent), Transform(Pose())))
  val turned: Entity = Entity.create(listOf(TransformParent(root), Transform(Pose())))
  private var placed = ""

  fun place(t: ItemTransform) {
    val key = r3(t.position) + "|" + r3(t.rotation)
    if (key == placed) return
    placed = key
    root.setComponent(Transform(Pose(t.position.sdk())))
    turned.setComponent(Transform(Pose(Vector3(0f), TransformMath.eulerDegreesToQuat(t.rotation).sdk())))
  }

  fun destroy() {
    turned.destroy()
    root.destroy()
  }
}

/**
 * The picked item's handles for the current mode (see [gizmoParts], sized as Decentraland's gizmo.ts), as entities
 * under the scene root [parent], so their coordinates are the scene's. Rebuilt when the mode, lock, item kind or scale
 * changes; otherwise only moved and turned with the item. Main thread only.
 */
class Gizmo(private val parent: Entity) {
  private var frame: ItemFrame? = null
  private var parts: List<Entity> = emptyList()
  private val grabs = HashMap<Entity, GizmoGrab>()
  private var builtFor = ""

  /** Shows [mode]'s handles on an [element] at [t]; null hides them. Call every frame. */
  fun update(mode: TransformMode, lock: MoveLock, element: String?, t: ItemTransform?) {
    if (element == null || t == null) return clear()
    val key = "$mode|$lock|${isFlat(element)}|${r3(t.scale)}"
    if (key != builtFor) {
      clear()
      build(gizmoParts(mode, lock, t.scale, element))
      builtFor = key
    }
    frame!!.place(t)
  }

  /** What dragging [entity] does, if it is one of the handles. */
  fun grabAt(entity: Entity): GizmoGrab? = grabs[entity]

  fun clear() {
    parts.forEach { it.destroy() }
    frame?.destroy()
    parts = emptyList()
    frame = null
    grabs.clear()
    builtFor = ""
  }

  private fun build(list: List<GizmoPart>) {
    val f = ItemFrame(parent)
    frame = f
    parts =
        list.map { p ->
          val color = p.color?.let(AXIS_COLORS::getValue) ?: WHITE
          box(if (p.inItemFrame) f.turned else f.root, p.centre, p.rotation, p.size, color, p.grab != null).also { e ->
            p.grab?.let { grabs[e] = it }
          }
        }
  }
}

/** The thin yellow edges round the picked item ([outlineEdges]), turned with it; never takes a hit. Main thread only. */
class PickOutline(private val parent: Entity) {
  private var frame: ItemFrame? = null
  private var edges: List<Entity> = emptyList()
  private var builtFor = ""

  /** Outlines an [element] at [t]; null removes it. Call every frame. */
  fun update(element: String?, t: ItemTransform?) {
    if (element == null || t == null) return clear()
    val key = "$element|${r3(t.scale)}"
    if (key != builtFor) {
      clear()
      val f = ItemFrame(parent)
      frame = f
      edges = outlineEdges(element, t.scale).map { box(f.turned, it.centre, Quat.IDENTITY, it.size, OUTLINE_COLOR, false) }
      builtFor = key
    }
    frame!!.place(t)
  }

  fun clear() {
    edges.forEach { it.destroy() }
    frame?.destroy()
    edges = emptyList()
    frame = null
    builtFor = ""
  }
}
