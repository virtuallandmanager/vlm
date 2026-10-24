package gg.vlm.spaces.builder

import gg.vlm.spaces.Quat
import gg.vlm.spaces.Vec3
import gg.vlm.spaces.api.BuilderCall
import gg.vlm.spaces.space.RootPose
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CarryControllerTest {
  private var t = 1_000_000L
  private fun v(x: Double, y: Double, z: Double) = Vec3(x, y, z)

  private val relayed = ArrayList<ItemTransform>()
  private val remote =
      object : BuilderRemote {
        override suspend fun draft(sk: String, element: String, t: ItemTransform): BuilderCall<DraftAnswer> {
          relayed += t
          return BuilderCall.Ok(DraftAnswer.Ok)
        }

        override suspend fun endDraft(sk: String, saved: Boolean) = BuilderCall.Ok(Unit)

        override suspend fun updateInstance(sk: String, t: ItemTransform) = BuilderCall.Ok(Unit)

        override suspend fun putAdjustment(sk: String, a: Adjustment) = BuilderCall.Ok(Unit)

        override suspend fun deleteAdjustment(sk: String) = BuilderCall.Ok(Unit)
      }
  private val editor = BuilderEditor(remote, DraftStore { t }, { t }, { block -> runBlocking { block() } })
  private val carry = CarryController(editor)
  private val root = RootPose(v(0.0, 0.0, 0.0), 0.0)
  private val poster =
      ItemTransform(v(0.0, 1.0, 0.0), v(0.0, 0.0, 0.0), v(1.0, 1.0, 1.0)).let {
        BuilderItem("in1", "el1:in1", "image", "Poster", it, it, null)
      }
  /** A wall at z = 0.1 facing -z, 10 m square around the item. */
  private val wall = Surface(SurfaceKind.WALL, v(0.0, 1.0, 0.1), v(0.0, 0.0, -1.0), 5.0, 5.0)

  private fun hand(id: String, grips: Int, thumbs: Int = 0, at: Vec3 = v(0.0, 1.0, -1.0)) =
      Hand(id, grips, thumbs, WorldPose(at, Quat.IDENTITY))

  private fun frame(vararg hands: Hand, root: RootPose? = this.root, busy: Boolean = false, surfaces: List<Surface> = listOf(wall)) =
      carry.frame(hands.toList(), root, busy) { surfaces }

  private fun picked(): ItemTransform = editor.pickedItem()!!.second

  init {
    editor.setItems(listOf(poster))
    editor.pick("in1")
  }

  private fun grabbed() {
    frame(hand("L", 0))
    frame(hand("L", GRIP_LEFT))
  }

  @Test
  fun `a grip pressed with the ray on the picked item starts a carry`() {
    grabbed()
    assertTrue(carry.carrying)
    assertTrue(editor.dragging)
  }

  @Test
  fun `a grip held down before pointing at the item, or pointing elsewhere, carries nothing`() {
    frame(hand("L", GRIP_LEFT, at = v(5.0, 1.0, -1.0)))
    frame(hand("L", GRIP_LEFT))
    assertFalse(carry.carrying)
    frame(hand("L", 0))
    frame(hand("L", GRIP_LEFT, at = v(5.0, 1.0, -1.0)))
    assertFalse(carry.carrying)
  }

  @Test
  fun `no carry starts while the pointer is pressing`() {
    frame(hand("L", 0))
    frame(hand("L", GRIP_LEFT), busy = true)
    assertFalse(carry.carrying)
  }

  @Test
  fun `the item follows the controller`() {
    grabbed()
    frame(hand("L", GRIP_LEFT, at = v(0.5, 1.0, -1.0)))
    assertEquals(0.5, picked().position.x, 1e-9)
  }

  @Test
  fun `a thumbstick flick turns the item 15 degrees, once per flick`() {
    grabbed()
    frame(hand("L", GRIP_LEFT, THUMB_LEFT_RIGHT))
    frame(hand("L", GRIP_LEFT, THUMB_LEFT_RIGHT))
    assertEquals(15.0, picked().rotation.y, 1e-6)
    frame(hand("L", GRIP_LEFT, 0))
    frame(hand("L", GRIP_LEFT, THUMB_LEFT_LEFT))
    assertEquals(0.0, picked().rotation.y, 1e-6)
  }

  @Test
  fun `a trigger during the carry cannot take over, and the grip's landing is kept`() {
    grabbed()
    editor.beginDrag(Handle.Body, Ray(v(0.0, 1.0, -3.0), v(0.0, 0.0, 1.0)))
    editor.drag(Ray(v(4.0, 1.0, -3.0), v(0.0, 0.0, 1.0)))
    assertTrue(carry.carrying)
    assertEquals(0.0, picked().position.x, 1e-9)
    frame(hand("L", GRIP_LEFT, at = v(0.0, 1.0, -1.0)))
    frame(hand("L", 0), surfaces = emptyList())
    assertFalse(carry.carrying)
    assertFalse(editor.dragging)
    assertEquals(0.0, picked().position.x, 1e-9)
  }

  @Test
  fun `losing the scene ends the carry so the item can be picked up again`() {
    grabbed()
    frame(hand("L", GRIP_LEFT), root = null)
    assertFalse(carry.carrying)
    assertFalse(editor.dragging)
    assertNotNull(editor.beginCarry())
  }

  @Test
  fun `letting go lands the item flush on a wall`() {
    grabbed()
    frame(hand("L", 0))
    assertFalse(carry.carrying)
    assertFalse(editor.dragging)
    val p = picked()
    assertEquals(0.1 - FLAT_HALF_DEPTH_M, p.position.z, 1e-9)
    assertEquals(180.0, p.rotation.y, 1e-6)
    assertEquals(0.1 - FLAT_HALF_DEPTH_M, relayed.last().position.z, 1e-9)
  }

  @Test
  fun `the other controller's grip turns snapping off`() {
    grabbed()
    val away = v(5.0, 1.0, -1.0)
    frame(hand("L", GRIP_LEFT), hand("R", GRIP_RIGHT, at = away))
    frame(hand("L", 0), hand("R", GRIP_RIGHT, at = away))
    assertEquals(0.0, picked().position.z, 1e-9)
    assertEquals(0.0, picked().rotation.y, 1e-6)
  }

  @Test
  fun `a carry is kept by its controller, not by whichever has the grip`() {
    grabbed()
    // The carrying controller is gone; another one reports the same grip.
    frame(hand("X", GRIP_LEFT))
    assertFalse(carry.carrying)
    assertEquals(0.1 - FLAT_HALF_DEPTH_M, picked().position.z, 1e-9)
  }

  @Test
  fun `cancel puts a carry in progress down where it is`() {
    grabbed()
    frame(hand("L", GRIP_LEFT, at = v(0.5, 1.0, -1.0)))
    carry.cancel()
    assertFalse(carry.carrying)
    assertFalse(editor.dragging)
    assertEquals(0.5, relayed.last().position.x, 1e-9)
  }
}
