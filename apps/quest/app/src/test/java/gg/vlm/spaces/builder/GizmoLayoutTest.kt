package gg.vlm.spaces.builder

import gg.vlm.spaces.Quat
import gg.vlm.spaces.Vec3
import gg.vlm.spaces.builder.TransformMath.eulerDegreesToQuat
import gg.vlm.spaces.builder.TransformMath.length
import gg.vlm.spaces.builder.TransformMath.rotateVector
import gg.vlm.spaces.builder.TransformMath.sub
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class GizmoLayoutTest {
  private fun v(x: Double, y: Double, z: Double) = Vec3(x, y, z)

  private val one = v(1.0, 1.0, 1.0)

  private fun near(a: Vec3, b: Vec3, eps: Double = 1e-9) = assertTrue("$a vs $b", length(sub(a, b)) < eps)

  @Test
  fun `the sizes are gizmo_ts's`() {
    assertEquals(0.12, HANDLE_SIZE, 0.0)
    assertEquals(0.04, RING_THICKNESS, 0.0)
    assertEquals(0.5, RING_MIN_RADIUS, 0.0)
  }

  @Test
  fun `ring radius is 0_6 of the largest scale, at least 0_5 m`() {
    assertEquals(0.5, ringRadius(v(0.5, 0.5, 0.5)), 1e-12)
    assertEquals(0.6, ringRadius(one), 1e-12)
    assertEquals(1.8, ringRadius(v(1.0, -3.0, 2.0)), 1e-12)
  }

  @Test
  fun `handles sit half the size plus a gap out, at least 0_3 m`() {
    assertEquals(0.3, handleOffset(0.1), 1e-12)
    assertEquals(1.15, handleOffset(2.0), 1e-12)
  }

  @Test
  fun `move has three axis handles that set their lock, on the scene's axes`() {
    val grabs = gizmoParts(TransformMode.MOVE, MoveLock.FREE, v(2.0, 1.0, 1.0), "model").filter { it.grab != null }
    assertEquals(listOf(MoveLock.X, MoveLock.Y, MoveLock.Z), grabs.map { it.grab!!.lock })
    assertTrue(grabs.all { it.grab!!.handle == Handle.Body && !it.inItemFrame && it.size == v(HANDLE_SIZE, HANDLE_SIZE, HANDLE_SIZE) })
    near(v(1.15, 0.0, 0.0), grabs[0].centre)
  }

  @Test
  fun `a locked move adds the 40 m guide along its axis`() {
    val free = gizmoParts(TransformMode.MOVE, MoveLock.FREE, one, "model")
    val locked = gizmoParts(TransformMode.MOVE, MoveLock.Y, one, "model")
    assertEquals(free.size + 1, locked.size)
    assertEquals(GUIDE_LENGTH, locked.last().size.y, 0.0)
    assertNull(locked.last().grab)
  }

  @Test
  fun `rotate has three rings of 32 segments lying round their axis`() {
    val parts = gizmoParts(TransformMode.ROTATE, MoveLock.FREE, v(0.5, 0.5, 0.5), "image")
    assertEquals(3 * RING_SEGMENTS, parts.size)
    for (p in parts) {
      val axis = (p.grab!!.handle as Handle.Ring).axis
      assertEquals(RING_MIN_RADIUS, length(p.centre), 1e-9)
      assertEquals("in the ring's plane", 0.0, p.centre[axis], 1e-9)
      // The box's local y is the ring's axis and its long local z runs along the ring.
      near(axis.unit, rotateVector(p.rotation, Axis.Y.unit), 1e-9)
      assertEquals(0.0, TransformMath.dot(rotateVector(p.rotation, Axis.Z.unit), p.centre), 1e-9)
      assertEquals(RING_THICKNESS, p.size.x, 0.0)
    }
  }

  @Test
  fun `resize has the corner handle and a stretch per axis, none along Z for flat items, turned with the item`() {
    val solid = gizmoParts(TransformMode.RESIZE, MoveLock.FREE, v(2.0, 1.0, 1.0), "model")
    assertEquals(listOf(Handle.Uniform, Handle.Stretch(Axis.X), Handle.Stretch(Axis.Y), Handle.Stretch(Axis.Z)), solid.map { it.grab!!.handle })
    assertTrue(solid.all { it.inItemFrame })
    near(v(1.15, 0.65, 0.65), solid[0].centre)
    val flat = gizmoParts(TransformMode.RESIZE, MoveLock.FREE, one, "image")
    assertEquals(3, flat.size)
  }

  @Test
  fun `basisQuat and lookRotation build the turn of an orthonormal basis`() {
    near(Vec3(0.0, 0.0, 0.0), sub(rotateVector(lookRotation(Axis.Z.unit, Axis.Y.unit), Axis.X.unit), Axis.X.unit))
    // Facing +X with Y up: local z → +X, local x → -Z (left-handed).
    val q = lookRotation(Axis.X.unit, Axis.Y.unit)
    near(Axis.X.unit, rotateVector(q, Axis.Z.unit))
    near(v(0.0, 0.0, -1.0), rotateVector(q, Axis.X.unit))
    // Each branch of the matrix-to-quaternion conversion.
    for (e in listOf(v(0.0, 180.0, 0.0), v(180.0, 0.0, 0.0), v(0.0, 0.0, 180.0), v(30.0, 200.0, 10.0))) {
      val r = eulerDegreesToQuat(e)
      val b = basisQuat(rotateVector(r, Axis.X.unit), rotateVector(r, Axis.Y.unit), rotateVector(r, Axis.Z.unit))
      for (a in Axis.entries) near(rotateVector(r, a.unit), rotateVector(b, a.unit), 1e-9)
    }
  }

  @Test
  fun `the renderer's YXZ euler turn is the session's DCL turn`() {
    for (e in listOf(v(30.0, 45.0, 60.0), v(-45.0, 200.0, 15.0), v(90.0, 30.0, 0.0))) {
      val a = Quat.yxzDegrees(e)
      val b = eulerDegreesToQuat(e)
      for (axis in Axis.entries) near(a.rotate(axis.unit), rotateVector(b, axis.unit), 1e-9)
    }
  }

  @Test
  fun `a flat item's outline is a four-edge frame, a model's a twelve-edge box rising from its base`() {
    val frame = outlineEdges("image", v(2.0, 1.0, 1.0))
    assertEquals(4, frame.size)
    assertTrue(frame.all { it.centre.z == 0.0 })
    val box = outlineEdges("model", v(2.0, 1.0, 1.0))
    assertEquals(12, box.size)
    assertEquals(0.5 + 0.5 + OUTLINE_PAD, box.maxOf { it.centre.y }, 1e-12)
    assertEquals(2.0 + 2 * OUTLINE_PAD + OUTLINE_THICKNESS, box.maxOf { it.size.x }, 1e-12)
    assertEquals(12, outlineEdges("sound", one).size)
  }
}
