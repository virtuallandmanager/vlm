package gg.vlm.spaces.builder

import com.meta.spatial.core.Entity
import com.meta.spatial.core.Pose
import com.meta.spatial.core.Quaternion
import com.meta.spatial.core.Vector3
import com.meta.spatial.toolkit.AppSystemActivity
import com.meta.spatial.toolkit.Grabbable
import com.meta.spatial.toolkit.Transform
import com.meta.spatial.toolkit.Visible
import com.meta.spatial.toolkit.createPanelEntity
import gg.vlm.spaces.AppState
import gg.vlm.spaces.R
import gg.vlm.spaces.SceneRenderer
import gg.vlm.spaces.Vec3
import gg.vlm.spaces.sdk
import gg.vlm.spaces.space.RootPose
import kotlin.math.sqrt

/**
 * [BuilderTools] on the headset: [Picking] (controller ray, trigger or pinch, and grip carries snapped to the room's
 * [surfaces]), the [Gizmo] and the [PickOutline] under the [renderer]'s scene root. Main thread only.
 */
class HeadsetBuilderTools(
    private val activity: AppSystemActivity,
    private val renderer: SceneRenderer,
    private val surfaces: () -> List<Surface>,
) : BuilderTools {
  private var editor: BuilderEditor? = null
  private var picking: Picking? = null
  private var gizmo: Gizmo? = null
  private var outline: PickOutline? = null

  override fun start(editor: BuilderEditor, root: () -> RootPose?) {
    stop()
    val g = Gizmo(renderer.root)
    val p =
        Picking(
            activity,
            editor,
            g,
            itemAt = { e -> renderer.keyAt(e)?.let { key -> editor.view().items.firstOrNull { it.renderKey == key }?.sk } },
            root = root,
            surfaces = surfaces,
        )
    p.start()
    this.editor = editor
    picking = p
    gizmo = g
    outline = PickOutline(renderer.root)
  }

  override fun tick() {
    val e = editor ?: return
    picking?.tick()
    val picked = e.pickedItem()
    gizmo?.update(e.mode, e.lock, picked?.first?.element, picked?.second)
    outline?.update(picked?.first?.element, picked?.second)
  }

  override fun stop() {
    picking?.stop()
    gizmo?.clear()
    outline?.clear()
    picking = null
    gizmo = null
    outline = null
    editor = null
  }
}

/**
 * The builder's panels on the headset, each shown while [ui] has content for it and put in front of the builder when
 * it opens: the pairing panel, the builder panel (pick list, "look at a ring"), the align panel, the ring panel (to
 * the right) and the HUD (to the left, [builderHudPlacement]). The HUD and the align panel can be grabbed and moved.
 * Main thread only.
 */
class BuilderPanels(private val ui: AppState) {
  private class Panel(val entity: Entity, val open: () -> Boolean, val place: (Pose) -> Pose) {
    var shown: Boolean? = null
  }

  private var panels: List<Panel> = emptyList()

  /** Creates the panels (hidden); call once the scene is ready. */
  fun create() {
    panels =
        listOf(
            panel(R.id.pairing_panel, grabbable = false, open = { ui.pairing != null }) { ahead(it, 0.8f, -0.05f, 0f) },
            panel(R.id.builder_prompt, grabbable = false, open = { ui.builderPrompt != null }) { ahead(it, 0.8f, -0.1f, 0f) },
            panel(R.id.align_panel, grabbable = true, open = { ui.align != null }) { ahead(it, 0.7f, -0.3f, 0f) },
            panel(R.id.ring_panel, grabbable = false, open = { ui.ringCheck != null }) { ahead(it, 0.7f, -0.15f, 0.45f) },
            panel(R.id.builder_hud, grabbable = true, open = { ui.hud != null }, place = ::hudPose),
        )
  }

  /** Shows and hides the panels; call every frame with the head pose. */
  fun update(head: Pose) {
    for (p in panels) {
      val open = p.open()
      if (open == p.shown) continue
      if (open) p.entity.setComponent(Transform(p.place(head)))
      p.entity.setComponent(Visible(open))
      p.shown = open
    }
  }

  private fun panel(id: Int, grabbable: Boolean, open: () -> Boolean, place: (Pose) -> Pose): Panel {
    val e = if (grabbable) Entity.createPanelEntity(id, Transform(Pose()), Grabbable()) else Entity.createPanelEntity(id, Transform(Pose()))
    e.setComponent(Visible(false))
    return Panel(e, open, place).also { it.shown = false }
  }

  private fun hudPose(head: Pose): Pose {
    val fwd = level(head)
    val (p, yaw) = builderHudPlacement(Vec3(head.t.x.toDouble(), head.t.y.toDouble(), head.t.z.toDouble()), Math.toDegrees(Math.atan2(fwd.x.toDouble(), fwd.z.toDouble())))
    val r = Math.toRadians(yaw)
    return Pose(p.sdk(), Quaternion.lookRotation(Vector3(Math.sin(r).toFloat(), 0f, Math.cos(r).toFloat())))
  }

  /** [distance] m ahead of [head] (level), [drop] m above its eyes, [right] m to its right, facing the way it looks. */
  private fun ahead(head: Pose, distance: Float, drop: Float, right: Float): Pose {
    val fwd = level(head)
    val side = Vector3(fwd.z, 0f, -fwd.x)
    val t = head.t + fwd * distance + side * right
    return Pose(Vector3(t.x, head.t.y + drop, t.z), Quaternion.lookRotation(fwd))
  }

  private fun level(head: Pose): Vector3 {
    val v = head.q.times(Vector3(0f, 0f, 1f))
    val len = sqrt(v.x * v.x + v.z * v.z)
    return if (len < 1e-3f) Vector3(0f, 0f, 1f) else Vector3(v.x / len, 0f, v.z / len)
  }
}
