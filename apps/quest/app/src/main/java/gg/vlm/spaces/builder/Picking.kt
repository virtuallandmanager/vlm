package gg.vlm.spaces.builder

import com.meta.spatial.core.Entity
import com.meta.spatial.core.Query
import com.meta.spatial.isdk.IsdkSystem
import com.meta.spatial.runtime.ButtonBits
import com.meta.spatial.runtime.PointerEvent
import com.meta.spatial.runtime.PointerEventType
import com.meta.spatial.runtime.SemanticType
import com.meta.spatial.toolkit.AppSystemActivity
import com.meta.spatial.toolkit.Controller
import com.meta.spatial.toolkit.Transform
import gg.vlm.spaces.Vec3
import gg.vlm.spaces.builder.TransformMath.dot
import gg.vlm.spaces.builder.TransformMath.normalize
import gg.vlm.spaces.builder.TransformMath.sub
import gg.vlm.spaces.space.RootPose
import gg.vlm.spaces.space.rotateY
import kotlin.math.cos

/** A press only becomes a drag once the pointer ray has turned this far, so a plain press picks without moving. */
const val DRAG_THRESHOLD_DEGREES = 2.0
private val DRAG_THRESHOLD_COS = cos(Math.toRadians(DRAG_THRESHOLD_DEGREES))

/** A world-space ray (a controller's or hand's pointer) in the scene's coordinates, the scene placed at [root]. */
fun sceneRay(origin: Vec3, direction: Vec3, root: RootPose): Ray =
    Ray(rotateY(-root.yawDeg, sub(origin, root.position)), normalize(rotateY(-root.yawDeg, direction)))

/** True once [now] has turned more than [DRAG_THRESHOLD_DEGREES] from [start] (both directions). */
fun passedDragThreshold(start: Vec3, now: Vec3): Boolean = dot(normalize(start), normalize(now)) < DRAG_THRESHOLD_COS

/** What the pointer pressed. */
sealed interface PressTarget {
  data class Gizmo(val grab: GizmoGrab) : PressTarget

  data class Item(val sk: String) : PressTarget

  data object Empty : PressTarget
}

/**
 * Trigger or pinch on the scene, as the editor sees it: pressing an item picks it; pressing the picked item (in Move)
 * or one of its gizmo handles arms a drag, which begins once the ray has turned past [DRAG_THRESHOLD_DEGREES] (from
 * the ray it was pressed with, so the grab point is where the press landed) and ends on release. Rays are in scene
 * coordinates. Main thread only.
 */
class PressTracker(private val editor: BuilderEditor) {
  private class Armed(val grab: GizmoGrab, val pressRay: Ray)

  private var armed: Armed? = null
  var dragging = false
    private set

  fun press(target: PressTarget, ray: Ray) {
    release()
    when (target) {
      is PressTarget.Gizmo -> if (editor.picked != null) armed = Armed(target.grab, ray)
      is PressTarget.Item ->
          when {
            target.sk != editor.picked -> editor.pick(target.sk)
            editor.mode == TransformMode.MOVE -> armed = Armed(GizmoGrab(Handle.Body), ray)
          }
      PressTarget.Empty -> Unit
    }
  }

  /** The pointer's ray this frame, while pressed. */
  fun move(ray: Ray) {
    val a = armed ?: return
    if (!dragging) {
      if (!passedDragThreshold(a.pressRay.direction, ray.direction)) return
      editor.beginDrag(a.grab.handle, a.pressRay, a.grab.lock)
      dragging = true
    }
    editor.drag(ray)
  }

  fun release() {
    if (dragging) editor.endDrag()
    dragging = false
    armed = null
  }
}

/**
 * Picks and drags with the controller ray and trigger or the hand's system pinch (`SemanticType.Select`, Task 1),
 * through [IsdkSystem.registerObserver]. Pressed entities are looked up in the [gizmo] first, then the scene's items
 * ([itemAt], a render key's item). While pressed, each [tick] reads the pressing pointer's pose, turns it into a scene
 * ray through [root] and feeds the [tracker]; a held grip on either controller turns snapping on (Shift in
 * Decentraland).
 *
 * **Unverified on device** (README, builder checks): that a plain `Mesh(hittable = LineTest)` item and the gizmo's
 * box handles produce ISDK `Select` events; that `PointerEvent.source`'s `Transform` is the pointer's world pose with
 * its ray along +Z; and that `Unselect` (or `Cancel`) arrives from the same source on release.
 */
class Picking(
    private val activity: AppSystemActivity,
    private val editor: BuilderEditor,
    private val gizmo: Gizmo,
    private val itemAt: (Entity) -> String?,
    private val root: () -> RootPose?,
) {
  private val tracker = PressTracker(editor)
  private var pressedBy: Entity? = null
  private var isdk: IsdkSystem? = null
  private val observer: (PointerEvent) -> Unit = ::onPointer

  fun start() {
    if (isdk != null) return
    isdk = activity.systemManager.tryFindSystem<IsdkSystem>()?.also { it.registerObserver(observer) }
  }

  fun stop() {
    isdk?.unregisterObserver(observer)
    isdk = null
    tracker.release()
    pressedBy = null
  }

  /** Call every frame while building. */
  fun tick() {
    editor.setSnap(gripHeld())
    val source = pressedBy ?: return
    rayOf(source)?.let(tracker::move)
  }

  private fun onPointer(e: PointerEvent) {
    when (e.type) {
      PointerEventType.Select.id -> {
        if (e.semanticType != SemanticType.Select.id) return
        val ray = rayOf(e.source) ?: return
        val hit: Entity? = e.hitInfo.entity
        val target =
            hit?.let { h -> gizmo.grabAt(h)?.let { PressTarget.Gizmo(it) } ?: itemAt(h)?.let { PressTarget.Item(it) } }
                ?: PressTarget.Empty
        pressedBy = e.source
        tracker.press(target, ray)
      }
      PointerEventType.Unselect.id,
      PointerEventType.Cancel.id -> {
        if (pressedBy != null && e.source != pressedBy) return
        tracker.release()
        pressedBy = null
      }
    }
  }

  /** The pointer's ray in scene coordinates, or null before the scene is placed. */
  private fun rayOf(source: Entity): Ray? {
    val r = root() ?: return null
    val pose = source.tryGetComponent<Transform>()?.transform ?: return null
    val f = pose.forward()
    return sceneRay(
        Vec3(pose.t.x.toDouble(), pose.t.y.toDouble(), pose.t.z.toDouble()),
        Vec3(f.x.toDouble(), f.y.toDouble(), f.z.toDouble()),
        r,
    )
  }

  private fun gripHeld(): Boolean {
    var held = false
    Query.where { has(Controller.id) }.eval().forEach { e ->
      val c = e.getComponent<Controller>()
      if (c.isActive && (c.buttonState and (ButtonBits.ButtonSqueezeL or ButtonBits.ButtonSqueezeR)) != 0) held = true
    }
    return held
  }
}
