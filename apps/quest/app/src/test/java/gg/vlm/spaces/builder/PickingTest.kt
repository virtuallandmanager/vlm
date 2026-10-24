package gg.vlm.spaces.builder

import gg.vlm.spaces.Vec3
import gg.vlm.spaces.api.BuilderCall
import gg.vlm.spaces.builder.TransformMath.normalize
import gg.vlm.spaces.space.RootPose
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PickingTest {
  private fun v(x: Double, y: Double, z: Double) = Vec3(x, y, z)

  private val unit = BuilderCall.Ok(Unit)

  private val remote =
      object : BuilderRemote {
        override suspend fun draft(sk: String, element: String, t: ItemTransform) = BuilderCall.Ok(DraftAnswer.Ok)

        override suspend fun endDraft(sk: String, saved: Boolean) = unit

        override suspend fun updateInstance(sk: String, t: ItemTransform) = unit

        override suspend fun putAdjustment(sk: String, a: Adjustment) = unit

        override suspend fun deleteAdjustment(sk: String) = unit
      }

  private var t = 0L
  private val store = DraftStore { t }
  private val editor = BuilderEditor(remote, store, { t }, { runBlocking { it() } })
  private val tracker = PressTracker(editor)
  private val at = ItemTransform(v(0.0, 1.0, 0.0), v(0.0, 0.0, 0.0), v(1.0, 1.0, 1.0))

  init {
    editor.setItems(listOf(BuilderItem("in1", "el1:in1", "image", "Poster", at, at, null), BuilderItem("in2", "el2:in2", "model", "Chair", at, at, null)))
  }

  /** From above, looking down at (x, 1, 0). */
  private fun down(x: Double) = Ray(v(0.0, 10.0, 0.0), normalize(v(x, -9.0, 0.0)))

  @Test
  fun `the scene ray undoes the root's place and turn`() {
    // The scene turned 90° (its +Z along world +X): world (1, 1.5, 3) is (0, 1.5, 2) from the root, scene (-2, 1.5, 0).
    val r = sceneRay(v(1.0, 1.5, 3.0), v(1.0, 0.0, 0.0), RootPose(v(1.0, 0.0, 1.0), 90.0))
    assertEquals(-2.0, r.origin.x, 1e-9)
    assertEquals(1.5, r.origin.y, 1e-9)
    assertEquals(0.0, r.origin.z, 1e-9)
    // World +X is the scene's +Z.
    assertEquals(0.0, r.direction.x, 1e-9)
    assertEquals(1.0, r.direction.z, 1e-9)
  }

  @Test
  fun `the drag threshold is 2 degrees`() {
    val a = v(0.0, 0.0, 1.0)
    assertFalse(passedDragThreshold(a, v(Math.tan(Math.toRadians(1.9)), 0.0, 1.0)))
    assertTrue(passedDragThreshold(a, v(Math.tan(Math.toRadians(2.1)), 0.0, 1.0)))
  }

  @Test
  fun `pressing an item picks it without moving it`() {
    tracker.press(PressTarget.Item("in1"), down(0.0))
    tracker.move(down(2.0))
    tracker.release()
    assertEquals("in1", editor.picked)
    assertTrue(store.drafts().isEmpty())
  }

  @Test
  fun `pressing the picked item in Move drags it once the ray has turned`() {
    editor.pick("in1")
    tracker.press(PressTarget.Item("in1"), down(0.0))
    tracker.move(down(0.01))
    assertFalse(tracker.dragging)
    tracker.move(down(1.0))
    assertTrue(tracker.dragging)
    tracker.release()
    assertFalse(editor.dragging)
    assertEquals(1.0, store.draft("in1")!!.now.position.x, 1e-9)
  }

  @Test
  fun `a gizmo handle drags in its own mode, and an axis handle sets the lock`() {
    editor.pick("in1")
    tracker.press(PressTarget.Gizmo(GizmoGrab(Handle.Body, MoveLock.Z)), down(0.0))
    tracker.move(down(1.0))
    assertEquals(MoveLock.Z, editor.lock)
    tracker.release()
    editor.setMode(TransformMode.ROTATE)
    // From above the item: the ray swings from 45° round the Y ring to -45°.
    tracker.press(PressTarget.Gizmo(GizmoGrab(Handle.Ring(Axis.Y))), Ray(v(0.0, 5.0, 0.0), normalize(v(0.5, -4.0, 0.5))))
    tracker.move(Ray(v(0.0, 5.0, 0.0), normalize(v(-0.5, -4.0, 0.5))))
    tracker.release()
    assertEquals(270.0, store.draft("in1")!!.now.rotation.y, 1e-6) // -90°, in [0, 360)
  }

  @Test
  fun `pressing another item picks it instead, and a gizmo press with nothing picked does nothing`() {
    tracker.press(PressTarget.Gizmo(GizmoGrab(Handle.Uniform)), down(0.0))
    tracker.move(down(1.0))
    assertNull(editor.picked)
    editor.pick("in1")
    tracker.press(PressTarget.Item("in2"), down(0.0))
    assertEquals("in2", editor.picked)
    tracker.press(PressTarget.Empty, down(0.0))
    assertEquals("in2", editor.picked)
  }
}
