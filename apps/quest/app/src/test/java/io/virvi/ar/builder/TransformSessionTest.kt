package io.virvi.ar.builder

import io.virvi.ar.Vec3
import io.virvi.ar.builder.TransformMath.eulerDegreesToQuat
import io.virvi.ar.builder.TransformMath.normalize
import io.virvi.ar.builder.TransformMath.quatFromAxisAngle
import io.virvi.ar.builder.TransformMath.quatMultiply
import io.virvi.ar.builder.TransformMath.quatToEulerDegrees
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Port of packages/core/test/transform-session.test.ts, case for case (plus [TransformSession.setLock]). */
class TransformSessionTest {
  private fun v(x: Double, y: Double, z: Double) = Vec3(x, y, z)

  private fun v(x: Int, y: Int, z: Int) = Vec3(x.toDouble(), y.toDouble(), z.toDouble())

  private fun down(x: Double, y: Double, z: Double) = Ray(v(x, y, z), v(0, -1, 0))

  private fun down(x: Int, y: Int, z: Int) = down(x.toDouble(), y.toDouble(), z.toDouble())

  private fun toward(origin: Vec3, dir: Vec3) = Ray(origin, normalize(dir))

  private val base = ItemTransform(v(1, 2, 3), v(0, 0, 0), v(1, 1, 1))

  private fun item(
      position: Vec3 = base.position,
      rotation: Vec3 = base.rotation,
      scale: Vec3 = base.scale,
  ) = Selected("model", "model#1", "Crate", ItemTransform(position, rotation, scale))

  private inner class H(interval: Long? = null) {
    var t = 0L
    val drafts = ArrayList<DraftPayload>()
    val session =
        if (interval == null) TransformSession({ t }, { drafts += it }) else TransformSession({ t }, { drafts += it }, interval)
  }

  private fun selected(
      position: Vec3 = base.position,
      rotation: Vec3 = base.rotation,
      scale: Vec3 = base.scale,
      mode: TransformMode = TransformMode.MOVE,
  ): H {
    val h = H()
    assertEquals(SelectResult.OK, h.session.select(item(position, rotation, scale)))
    h.session.setMode(mode)
    return h
  }

  private fun close(expected: Double, actual: Double?, eps: Double = 1e-6) =
      assertTrue("expected $expected, got $actual", actual != null && Math.abs(expected - actual) < eps)

  private fun close4(expected: Double, actual: Double?) = close(expected, actual, 5e-5)

  private val origin = v(0, 0, 0)

  // ── selection ──

  @Test
  fun `starts empty and clean`() {
    val s = H().session
    assertNull(s.selected)
    assertNull(s.draft)
    assertFalse(s.dirty)
    assertEquals(TransformMode.MOVE, s.mode)
    assertEquals(MoveLock.FREE, s.lock)
  }

  @Test
  fun `selecting exposes the item and a draft equal to its transform`() {
    val s = selected().session
    assertEquals("model#1", s.selected?.sk)
    assertEquals(item().transform, s.draft)
    assertFalse(s.dirty)
  }

  @Test
  fun `refuses a new selection while dirty, even the same sk`() {
    val s = selected().session
    s.beginDrag(Handle.Body, down(0, 10, 0), v(5, 0, 5))
    s.drag(down(0, 10, 0), v(6, 0, 6))
    s.endDrag()
    assertTrue(s.dirty)
    assertEquals(SelectResult.DIRTY, s.select(item().copy(sk = "model#2")))
    assertEquals(SelectResult.DIRTY, s.select(item()))
    assertEquals("model#1", s.selected?.sk)
  }

  @Test
  fun `accepts a new selection once saved`() {
    val s = selected().session
    s.beginDrag(Handle.Body, down(0, 10, 0), v(5, 0, 5))
    s.drag(down(0, 10, 0), v(6, 0, 6))
    s.endDrag()
    s.takeSave()
    assertEquals(SelectResult.OK, s.select(item().copy(sk = "model#2")))
    assertEquals("model#2", s.selected?.sk)
  }

  @Test
  fun `does not alias the caller transform`() {
    // Kotlin's ItemTransform is immutable, so the caller's value can't change; the case is kept for parity.
    val h = H()
    val it = item()
    h.session.select(it)
    h.session.setMode(TransformMode.MOVE)
    h.session.beginDrag(Handle.Body, down(0, 10, 0), v(5, 0, 5))
    h.session.drag(down(0, 10, 0), v(6, 0, 6))
    assertEquals(v(1, 2, 3), it.transform.position)
  }

  @Test
  fun `clear drops selection, draft and drag state`() {
    val h = selected()
    val s = h.session
    s.beginDrag(Handle.Body, down(0, 10, 0), v(5, 0, 5))
    s.clear()
    assertNull(s.selected)
    assertNull(s.draft)
    assertFalse(s.dirty)
    s.drag(down(0, 10, 0), v(6, 0, 6))
    s.endDrag()
    assertNull(s.draft)
    assertTrue(h.drafts.isEmpty())
  }

  // ── move ──

  @Test
  fun `free move snaps to the surface hit`() {
    val s = selected().session
    s.beginDrag(Handle.Body, down(0, 10, 0), null)
    s.drag(down(0, 10, 0), v(3, 0, 4))
    assertEquals(v(3, 0, 4), s.draft?.position)
    assertEquals(v(0, 0, 0), s.draft?.rotation)
    assertTrue(s.dirty)
  }

  @Test
  fun `ignores a surface hit farther than 50 m and uses the fallback plane through the item`() {
    val s = selected().session
    val ray = toward(v(0, 10, 0), v(1, -1, 0))
    s.beginDrag(Handle.Body, ray, null)
    s.drag(ray, v(100, 0, 0))
    close(8.0, s.draft?.position?.x)
    close(2.0, s.draft?.position?.y)
    close(0.0, s.draft?.position?.z)
  }

  @Test
  fun `leaves the draft unchanged when there is no hit and the ray is parallel to the plane`() {
    val h = selected()
    val flat = toward(v(0, 2, 0), v(1, 0, 0))
    h.session.beginDrag(Handle.Body, flat, null)
    h.session.drag(flat, null)
    assertEquals(item().transform, h.session.draft)
    assertFalse(h.session.dirty)
    assertTrue(h.drafts.isEmpty())
  }

  @Test
  fun `leaves the draft unchanged when the fallback plane is behind the ray`() {
    val s = selected().session
    val up = toward(v(0, 10, 0), v(0, 1, 0))
    s.beginDrag(Handle.Body, up, null)
    s.drag(up, null)
    assertEquals(item().transform, s.draft)
  }

  @Test
  fun `cycles the lock free - x - y - z - free`() {
    val s = selected().session
    assertEquals(
        listOf(MoveLock.X, MoveLock.Y, MoveLock.Z, MoveLock.FREE),
        listOf(s.cycleLock(), s.cycleLock(), s.cycleLock(), s.cycleLock()),
    )
    assertEquals(MoveLock.FREE, s.lock)
  }

  @Test
  fun `axis lock moves only along the axis by the closest-point delta`() {
    val s = selected().session
    s.cycleLock() // x
    s.beginDrag(Handle.Body, down(2, 5, 3), null)
    s.drag(down(6, 5, 9), v(0, 0, 0))
    close(5.0, s.draft?.position?.x) // 1 + (6 - 2)
    assertEquals(2.0, s.draft!!.position.y, 0.0)
    assertEquals(3.0, s.draft!!.position.z, 0.0)
  }

  @Test
  fun `axis lock ignores a near-parallel ray (null closest point)`() {
    val s = selected().session
    s.cycleLock() // x
    s.beginDrag(Handle.Body, down(2, 5, 3), null)
    s.drag(toward(v(0, 2, 3), v(1, 0, 0)), null)
    assertEquals(item().transform, s.draft)
  }

  @Test
  fun `rebases when the lock changes mid-drag`() {
    val s = selected().session
    s.cycleLock() // x
    s.beginDrag(Handle.Body, down(2, 5, 3), null)
    s.drag(down(6, 5, 3), null)
    close(5.0, s.draft?.position?.x)
    s.cycleLock() // y
    // new grab happens at the next drag from the draft; first frame must not jump
    val side = toward(v(10, 4, 5), v(-1, 0, 0))
    s.drag(side, null)
    close(5.0, s.draft?.position?.x)
    assertEquals(2.0, s.draft!!.position.y, 0.0)
    assertEquals(3.0, s.draft!!.position.z, 0.0)
    s.drag(toward(v(10, 7, 5), v(-1, 0, 0)), null)
    close(5.0, s.draft?.position?.x)
    close(5.0, s.draft?.position?.y) // 2 + (7 - 4)
    close(3.0, s.draft?.position?.z)
  }

  @Test
  fun `axis lock retries an unresolved grab on the next frame instead of dying`() {
    val s = selected().session
    s.cycleLock() // x
    s.beginDrag(Handle.Body, toward(v(0, 2, 3), v(1, 0, 0)), null) // parallel: no grab
    s.drag(down(2, 5, 3), null) // becomes the grab; no movement
    assertEquals(item().transform, s.draft)
    s.drag(down(6, 5, 3), null)
    close(5.0, s.draft?.position?.x) // 1 + (6 - 2)
  }

  @Test
  fun `cycleLock while not dragging only changes the lock`() {
    val s = selected().session
    s.cycleLock()
    assertEquals(MoveLock.X, s.lock)
    assertFalse(s.dirty)
  }

  @Test
  fun `ignores a handle that does not fit the mode`() {
    val s = selected().session
    s.beginDrag(Handle.Ring(Axis.X), down(0, 10, 0), null)
    s.drag(down(0, 10, 0), v(9, 9, 9))
    assertEquals(item().transform, s.draft)
    s.endDrag()
  }

  @Test
  fun `setLock picks the lock directly, for the gizmo's axis handles`() {
    val s = selected().session
    s.setLock(MoveLock.Y)
    assertEquals(MoveLock.Y, s.lock)
    s.beginDrag(Handle.Body, toward(v(10, 4, 3), v(-1, 0, 0)), null)
    s.drag(toward(v(10, 6, 3), v(-1, 0, 0)), null)
    close(1.0, s.draft?.position?.x)
    close(4.0, s.draft?.position?.y) // 2 + (6 - 4)
  }

  // ── rotate ──

  @Test
  fun `composes the ring delta with the start rotation (non-commuting)`() {
    val s = selected(position = origin, rotation = v(0, 90, 0), mode = TransformMode.ROTATE).session
    s.beginDrag(Handle.Ring(Axis.X), toward(v(5, 1, 0), v(-1, 0, 0)), null)
    s.drag(toward(v(5, 0, 1), v(-1, 0, 0)), null) // +90 degrees about x
    val expected = quatToEulerDegrees(quatMultiply(quatFromAxisAngle(Axis.X.unit, 90.0), eulerDegreesToQuat(v(0, 90, 0))))
    val wrongOrder = quatToEulerDegrees(quatMultiply(eulerDegreesToQuat(v(0, 90, 0)), quatFromAxisAngle(Axis.X.unit, 90.0)))
    val r = s.draft!!.rotation
    close4(expected.x, r.x)
    close4(expected.y, r.y)
    close4(expected.z, r.z)
    assertTrue(Math.abs(r.z - wrongOrder.z) + Math.abs(r.x - wrongOrder.x) > 1)
  }

  private fun aroundX(deg: Double): Ray {
    val r = Math.toRadians(deg)
    return toward(v(5.0, Math.cos(r), Math.sin(r)), v(-1, 0, 0))
  }

  @Test
  fun `snaps the total delta to 15 degrees when snap is on`() {
    val s = selected(position = origin, mode = TransformMode.ROTATE).session
    s.setSnap(true)
    s.beginDrag(Handle.Ring(Axis.X), aroundX(0.0), null)
    s.drag(aroundX(20.0), null)
    close4(15.0, s.draft?.rotation?.x)
  }

  @Test
  fun `toggling snap mid-drag re-evaluates from the drag start`() {
    val s = selected(position = origin, mode = TransformMode.ROTATE).session
    s.beginDrag(Handle.Ring(Axis.X), aroundX(0.0), null)
    s.drag(aroundX(20.0), null)
    close4(20.0, s.draft?.rotation?.x)
    s.setSnap(true)
    s.drag(aroundX(21.0), null)
    close4(15.0, s.draft?.rotation?.x)
    s.setSnap(false)
    s.drag(aroundX(22.0), null)
    close4(22.0, s.draft?.rotation?.x)
  }

  @Test
  fun `accumulates across the +-180 boundary without jumping`() {
    val s = selected(position = origin, mode = TransformMode.ROTATE).session
    // hits the y=0 plane at angle deg from +z toward +x
    fun a(deg: Double): Ray {
      val r = Math.toRadians(deg)
      return down(Math.sin(r), 5.0, Math.cos(r))
    }
    s.beginDrag(Handle.Ring(Axis.Y), a(170.0), null)
    s.drag(a(180.0), null)
    s.drag(a(-170.0), null) // total +20
    close4(0.0, s.draft?.rotation?.x)
    close4(20.0, s.draft?.rotation?.y)
    s.drag(a(-160.0), null) // total +30
    close4(30.0, s.draft?.rotation?.y)
  }

  @Test
  fun `leaves the draft unchanged when the ray misses the ring plane`() {
    val s = selected(position = origin, mode = TransformMode.ROTATE).session
    s.beginDrag(Handle.Ring(Axis.X), toward(v(5, 1, 0), v(-1, 0, 0)), null)
    s.drag(toward(v(0, 1, 0), v(0, 0, 1)), null)
    assertEquals(item(position = origin).transform, s.draft)
  }

  @Test
  fun `a ring click with no movement leaves an awkward start rotation untouched and clean`() {
    for (rotation in listOf(v(-10, 370, 5), v(90, 0, 30), v(-90, 45, 20))) {
      val h = selected(position = origin, rotation = rotation, mode = TransformMode.ROTATE)
      val ray = toward(v(5, 1, 0), v(-1, 0, 0))
      h.session.beginDrag(Handle.Ring(Axis.X), ray, null)
      h.session.drag(ray, null)
      h.session.endDrag()
      assertEquals(rotation, h.session.draft?.rotation)
      assertFalse(h.session.dirty)
      assertTrue(h.drafts.isEmpty())
    }
  }

  @Test
  fun `snap that rounds the delta to zero keeps the exact start rotation`() {
    val s = selected(position = origin, rotation = v(90, 0, 30), mode = TransformMode.ROTATE).session
    s.setSnap(true)
    s.beginDrag(Handle.Ring(Axis.X), aroundX(0.0), null)
    s.drag(aroundX(5.0), null)
    assertEquals(v(90, 0, 30), s.draft?.rotation)
    assertFalse(s.dirty)
  }

  @Test
  fun `rotating +30 then back -30 reads clean`() {
    val s = selected(position = origin, rotation = v(10, 20, 30), mode = TransformMode.ROTATE).session
    s.beginDrag(Handle.Ring(Axis.X), aroundX(0.0), null)
    s.drag(aroundX(30.0), null)
    assertTrue(s.dirty)
    s.drag(aroundX(0.0), null)
    assertFalse(s.dirty)
  }

  @Test
  fun `rotating back to a start near 0 reads clean even if it lands at 359_99999`() {
    val s = selected(position = origin, rotation = v(0, 0, 0), mode = TransformMode.ROTATE).session
    s.beginDrag(Handle.Ring(Axis.X), aroundX(0.0), null)
    s.drag(aroundX(-30.0), null)
    s.drag(aroundX(0.0), null)
    assertFalse(s.dirty)
  }

  @Test
  fun `ignores a body handle in rotate mode`() {
    val s = selected(position = origin, mode = TransformMode.ROTATE).session
    s.beginDrag(Handle.Body, down(0, 5, 0), null)
    s.drag(down(0, 5, 0), v(4, 4, 4))
    assertEquals(item(position = origin).transform, s.draft)
  }

  // ── resize ──

  private fun facing(x: Double) = toward(v(x, 0.0, 10.0), v(0, 0, -1))

  @Test
  fun `uniform scales by the distance ratio on the camera-facing plane`() {
    val s = selected(position = origin, scale = v(2.0, 1.0, 0.5), mode = TransformMode.RESIZE).session
    s.beginDrag(Handle.Uniform, facing(2.0), null)
    s.drag(facing(3.0), null)
    close(3.0, s.draft?.scale?.x)
    close(1.5, s.draft?.scale?.y)
    close(0.75, s.draft?.scale?.z)
  }

  @Test
  fun `uniform snaps the factor to 0_1`() {
    val s = selected(position = origin, mode = TransformMode.RESIZE).session
    s.setSnap(true)
    s.beginDrag(Handle.Uniform, facing(2.0), null)
    s.drag(facing(2.62), null)
    close(1.3, s.draft?.scale?.x)
    close(1.3, s.draft?.scale?.y)
  }

  @Test
  fun `uniform snap never goes below a factor of 0_1`() {
    val s = selected(position = origin, mode = TransformMode.RESIZE).session
    s.setSnap(true)
    s.beginDrag(Handle.Uniform, facing(2.0), null)
    s.drag(facing(0.02), null)
    close(0.1, s.draft?.scale?.x)
  }

  @Test
  fun `uniform floors components at 0_05`() {
    val s = selected(position = origin, mode = TransformMode.RESIZE).session
    s.beginDrag(Handle.Uniform, facing(2.0), null)
    s.drag(facing(0.05), null)
    assertEquals(v(0.05, 0.05, 0.05), s.draft?.scale)
  }

  @Test
  fun `uniform does nothing when grabbed at the item centre`() {
    val s = selected(position = origin, mode = TransformMode.RESIZE).session
    s.beginDrag(Handle.Uniform, facing(0.005), null)
    s.drag(facing(3.0), null)
    assertEquals(item(position = origin).transform, s.draft)
  }

  @Test
  fun `uniform uses a plane fixed at drag start, not the current ray direction`() {
    val s = selected(position = origin, mode = TransformMode.RESIZE).session
    s.beginDrag(Handle.Uniform, facing(2.0), null)
    s.drag(toward(v(4, 0, 10), v(0, 0, -1)), null)
    close(2.0, s.draft?.scale?.x)
  }

  @Test
  fun `stretch changes only its axis, proportional to distance from the centre`() {
    val s = selected(position = origin, scale = v(2, 1, 1), mode = TransformMode.RESIZE).session
    s.beginDrag(Handle.Stretch(Axis.X), down(4, 5, 0), null)
    s.drag(down(6, 5, 0), null)
    assertEquals(v(3, 1, 1), s.draft?.scale)
  }

  @Test
  fun `stretch is symmetric across the item centre`() {
    val s = selected(position = origin, scale = v(2, 1, 1), mode = TransformMode.RESIZE).session
    s.beginDrag(Handle.Stretch(Axis.X), down(4, 5, 0), null)
    s.drag(down(-6, 5, 0), null)
    close(3.0, s.draft?.scale?.x)
  }

  @Test
  fun `stretch snaps the resulting size to 0_25`() {
    val s = selected(position = origin, scale = v(2, 1, 1), mode = TransformMode.RESIZE).session
    s.setSnap(true)
    s.beginDrag(Handle.Stretch(Axis.X), down(4, 5, 0), null)
    s.drag(down(5.3, 5.0, 0.0), null) // size 2.65
    close(2.75, s.draft?.scale?.x)
    assertEquals(1.0, s.draft!!.scale.y, 0.0)
  }

  @Test
  fun `stretch snap never goes below 0_25, and unsnapped floors at 0_05`() {
    val s = selected(position = origin, scale = v(2, 1, 1), mode = TransformMode.RESIZE).session
    s.beginDrag(Handle.Stretch(Axis.Y), toward(v(5, 4, 0), v(-1, 0, 0)), null)
    s.drag(toward(v(5.0, 0.01, 0.0), v(-1, 0, 0)), null)
    close(0.05, s.draft?.scale?.y)
    s.setSnap(true)
    s.drag(toward(v(5.0, 0.01, 0.0), v(-1, 0, 0)), null)
    close(0.25, s.draft?.scale?.y)
  }

  @Test
  fun `stretch does nothing when grabbed at the centre`() {
    val s = selected(position = origin, scale = v(2, 1, 1), mode = TransformMode.RESIZE).session
    s.beginDrag(Handle.Stretch(Axis.X), down(0.005, 5.0, 0.0), null)
    s.drag(down(5, 5, 0), null)
    assertEquals(v(2, 1, 1), s.draft?.scale)
  }

  @Test
  fun `stretch follows the item's own axes - yaw 90 X handle tracks local X (scene -Z), not scene X`() {
    val s = selected(position = origin, rotation = v(0, 90, 0), scale = v(2, 1, 1), mode = TransformMode.RESIZE).session
    s.beginDrag(Handle.Stretch(Axis.X), down(0, 5, -4), null)
    s.drag(down(0, 5, -6), null) // along local X
    close(3.0, s.draft?.scale?.x)
    assertEquals(1.0, s.draft!!.scale.y, 0.0)
    assertEquals(1.0, s.draft!!.scale.z, 0.0)
    s.drag(down(3, 5, -6), null) // along scene X: no change
    close(3.0, s.draft?.scale?.x)
  }

  @Test
  fun `stretch along scene X does nothing for a yaw-90 item grabbed on its local X`() {
    val s = selected(position = origin, rotation = v(0, 90, 0), scale = v(2, 1, 1), mode = TransformMode.RESIZE).session
    s.beginDrag(Handle.Stretch(Axis.X), down(0, 5, -4), null)
    s.drag(down(5, 5, -4), null)
    assertEquals(v(2, 1, 1), s.draft?.scale)
  }

  @Test
  fun `stretch ignores a closest point farther than 50 m from the ray origin`() {
    val s = selected(position = origin, scale = v(2, 1, 1), mode = TransformMode.RESIZE).session
    s.beginDrag(Handle.Stretch(Axis.X), down(4, 5, 0), null)
    s.drag(down(6, 60, 0), null)
    assertEquals(v(2, 1, 1), s.draft?.scale)
  }

  // ── save / revert / emit ──

  private fun dragged(): H {
    val h = selected()
    h.session.beginDrag(Handle.Body, down(0, 10, 0), null)
    h.session.drag(down(0, 10, 0), v(7, 0, 8))
    h.session.endDrag()
    return h
  }

  @Test
  fun `takeSave returns null when nothing changed`() {
    assertNull(selected().session.takeSave())
  }

  @Test
  fun `takeSave returns the draft, marks clean, and becomes the new baseline`() {
    val s = dragged().session
    val saved = s.takeSave()
    assertEquals(DraftPayload("model", "model#1", ItemTransform(v(7, 0, 8), v(0, 0, 0), v(1, 1, 1))), saved)
    assertFalse(s.dirty)
    assertNull(s.takeSave())
    assertEquals(saved!!.transform, s.revert())
  }

  @Test
  fun `revert returns the selection-time transform and marks clean`() {
    val s = dragged().session
    assertEquals(item().transform, s.revert())
    assertEquals(item().transform, s.draft)
    assertFalse(s.dirty)
  }

  @Test
  fun `dragging back to the baseline is clean again`() {
    val s = dragged().session
    s.beginDrag(Handle.Body, down(0, 10, 0), null)
    s.drag(down(0, 10, 0), v(1, 2, 3))
    s.endDrag()
    assertFalse(s.dirty)
  }

  @Test
  fun `revert and takeSave with no selection return null`() {
    val s = H().session
    assertNull(s.revert())
    assertNull(s.takeSave())
  }

  @Test
  fun `emits on the first changing drag, then every 100 ms or more, and once more on endDrag`() {
    val h = selected()
    h.session.beginDrag(Handle.Body, down(0, 10, 0), null)
    listOf(0L, 30L, 60L, 90L, 120L, 150L).forEachIndexed { i, t ->
      h.t = t
      h.session.drag(down(0, 10, 0), v(10 + i, 0, 0))
    }
    assertEquals(2, h.drafts.size)
    h.t = 160
    h.session.endDrag()
    assertEquals(3, h.drafts.size)
    assertEquals(DraftPayload("model", "model#1", ItemTransform(v(15, 0, 0), v(0, 0, 0), v(1, 1, 1))), h.drafts[2])
  }

  @Test
  fun `honours a custom draftIntervalMs`() {
    val h = H(interval = 50)
    h.session.select(item())
    h.session.beginDrag(Handle.Body, down(0, 10, 0), null)
    listOf(0L, 30L, 60L).forEachIndexed { i, t ->
      h.t = t
      h.session.drag(down(0, 10, 0), v(10 + i, 0, 0))
    }
    assertEquals(2, h.drafts.size)
  }

  @Test
  fun `a bare click (drag that changes nothing) emits nothing, even on endDrag`() {
    val h = selected()
    h.session.beginDrag(Handle.Body, down(0, 10, 0), null)
    h.session.drag(down(0, 10, 0), v(1, 2, 3))
    h.session.endDrag()
    assertTrue(h.drafts.isEmpty())
  }

  @Test
  fun `endDrag emits a newer position that fell inside the throttle window, and only once`() {
    val h = selected()
    h.session.beginDrag(Handle.Body, down(0, 10, 0), null)
    h.t = 0
    h.session.drag(down(0, 10, 0), v(10, 0, 0))
    h.t = 30
    h.session.drag(down(0, 10, 0), v(11, 0, 0))
    assertEquals(1, h.drafts.size)
    h.session.endDrag()
    assertEquals(2, h.drafts.size)
    assertEquals(v(11, 0, 0), h.drafts[1].transform.position)
  }

  @Test
  fun `endDrag does not repeat a draft that was already emitted`() {
    val h = selected()
    h.session.beginDrag(Handle.Body, down(0, 10, 0), null)
    h.t = 0
    h.session.drag(down(0, 10, 0), v(10, 0, 0))
    h.session.endDrag()
    assertEquals(1, h.drafts.size)
  }

  @Test
  fun `setMode during a drag flushes the unsent draft ignoring the throttle, then cancels the drag`() {
    val h = selected()
    h.session.beginDrag(Handle.Body, down(0, 10, 0), null)
    h.t = 0
    h.session.drag(down(0, 10, 0), v(10, 0, 0))
    h.t = 30
    h.session.drag(down(0, 10, 0), v(11, 0, 0))
    assertEquals(1, h.drafts.size)
    h.session.setMode(TransformMode.ROTATE)
    assertEquals(2, h.drafts.size)
    assertEquals(v(11, 0, 0), h.drafts[1].transform.position)
    h.session.drag(down(0, 10, 0), v(20, 0, 0))
    h.session.endDrag()
    assertEquals(v(11, 0, 0), h.session.draft?.position)
    assertEquals(2, h.drafts.size)
  }

  @Test
  fun `setMode during a drag with nothing unsent, or with no drag, emits nothing`() {
    val h = selected()
    h.session.setMode(TransformMode.ROTATE)
    h.session.setMode(TransformMode.MOVE)
    h.session.beginDrag(Handle.Body, down(0, 10, 0), null)
    h.session.drag(down(0, 10, 0), v(1, 2, 3))
    h.session.setMode(TransformMode.RESIZE)
    assertTrue(h.drafts.isEmpty())
  }

  @Test
  fun `selected returns a copy and takeSave updates the selection transform`() {
    val s = dragged().session
    assertEquals(v(1, 2, 3), s.selected?.transform?.position)
    s.takeSave()
    assertEquals(v(7, 0, 8), s.selected?.transform?.position)
  }

  @Test
  fun `takeSave then a new drag then revert returns the saved transform`() {
    val s = dragged().session
    s.takeSave()
    s.beginDrag(Handle.Body, down(0, 10, 0), null)
    s.drag(down(0, 10, 0), v(20, 0, 20))
    s.endDrag()
    assertTrue(s.dirty)
    assertEquals(v(7, 0, 8), s.revert()?.position)
    assertFalse(s.dirty)
  }

  @Test
  fun `takeSave during an active drag saves the current draft - further frames dirty it again`() {
    val s = selected().session
    s.beginDrag(Handle.Body, down(0, 10, 0), null)
    s.drag(down(0, 10, 0), v(7, 0, 8))
    assertEquals(v(7, 0, 8), s.takeSave()?.transform?.position)
    assertFalse(s.dirty)
    s.drag(down(0, 10, 0), v(9, 0, 9))
    assertTrue(s.dirty)
    assertEquals(v(7, 0, 8), s.revert()?.position)
  }

  @Test
  fun `endDrag without a drag does not emit`() {
    val h = selected()
    h.session.endDrag()
    assertTrue(h.drafts.isEmpty())
  }

  @Test
  fun `never hands out internal objects`() {
    // ItemTransform and Vec3 are immutable in Kotlin, so nothing handed out can be changed; kept for parity.
    val h = selected()
    h.session.beginDrag(Handle.Body, down(0, 10, 0), null)
    h.session.drag(down(0, 10, 0), v(7, 0, 8))
    h.session.endDrag()
    assertEquals(7.0, h.session.draft!!.position.x, 0.0)
    assertEquals(7.0, h.session.takeSave()!!.transform.position.x, 0.0)
    assertEquals(7.0, h.session.revert()!!.position.x, 0.0)
  }

  // ── exact values ──

  @Test
  fun `move sets one position axis, emits a draft and makes the session dirty`() {
    val h = selected()
    assertTrue(h.session.setValue(Axis.Y, 4.5))
    assertEquals(v(1.0, 4.5, 3.0), h.session.draft!!.position)
    assertTrue(h.session.dirty)
    assertEquals(listOf(DraftPayload("model", "model#1", h.session.draft!!)), h.drafts)
  }

  @Test
  fun `rotate sets a rotation axis in degrees`() {
    val s = selected(mode = TransformMode.ROTATE).session
    s.setValue(Axis.Y, 90.0)
    assertEquals(v(0, 90, 0), s.draft!!.rotation)
    assertEquals(v(1, 2, 3), s.draft!!.position)
  }

  @Test
  fun `resize sets a scale axis, floored at 0_05`() {
    val s = selected(mode = TransformMode.RESIZE).session
    s.setValue(Axis.X, 2.5)
    assertEquals(v(2.5, 1.0, 1.0), s.draft!!.scale)
    s.setValue(Axis.Z, -3.0)
    assertEquals(0.05, s.draft!!.scale.z, 0.0)
  }

  @Test
  fun `refuses a value that is not a finite number and changes nothing`() {
    val h = selected()
    assertFalse(h.session.setValue(Axis.X, Double.NaN))
    assertFalse(h.session.setValue(Axis.X, Double.POSITIVE_INFINITY))
    assertEquals(v(1, 2, 3), h.session.draft!!.position)
    assertTrue(h.drafts.isEmpty())
  }

  @Test
  fun `setting the current value again emits nothing`() {
    val h = selected()
    assertTrue(h.session.setValue(Axis.X, 1.0))
    assertTrue(h.drafts.isEmpty())
  }

  @Test
  fun `setValue does nothing without a selection`() {
    assertFalse(H().session.setValue(Axis.X, 1.0))
  }

  @Test
  fun `ends a drag in progress so the next frame does not overwrite the typed value`() {
    val s = selected().session
    s.beginDrag(Handle.Body, down(1, 10, 3), v(1, 0, 3))
    s.setValue(Axis.X, 7.0)
    s.drag(down(5, 10, 5), v(5, 0, 5))
    assertEquals(v(7, 2, 3), s.draft!!.position)
  }

  @Test
  fun `revert undoes a typed value`() {
    val s = selected().session
    s.setValue(Axis.X, 7.0)
    s.revert()
    assertEquals(v(1, 2, 3), s.draft!!.position)
    assertFalse(s.dirty)
  }

  // ── mirrored items, carrying and clearing (plan 3 Task 8) ──

  @Test
  fun `uniform keeps a mirrored axis mirrored, also at the floor`() {
    val s = selected(position = origin, scale = v(-2, 1, 1), mode = TransformMode.RESIZE).session
    s.beginDrag(Handle.Uniform, facing(2.0), null)
    s.drag(facing(1.0), null)
    assertEquals(v(-1.0, 0.5, 0.5), s.draft?.scale)
    s.drag(facing(0.05), null)
    assertEquals(v(-0.05, 0.05, 0.05), s.draft?.scale)
  }

  @Test
  fun `stretch keeps a mirrored axis mirrored, at its size, snapped and at the floor`() {
    val s = selected(position = origin, scale = v(-2, 1, 1), mode = TransformMode.RESIZE).session
    s.beginDrag(Handle.Stretch(Axis.X), down(4, 5, 0), null)
    s.drag(down(6, 5, 0), null)
    assertEquals(v(-3, 1, 1), s.draft?.scale)
    s.setSnap(true)
    s.drag(down(5.3, 5.0, 0.0), null) // size 2.65 snaps to 2.75
    close(-2.75, s.draft?.scale?.x)
    s.setSnap(false)
    s.drag(down(0.01, 5.0, 0.0), null)
    close(-0.05, s.draft?.scale?.x)
  }

  @Test
  fun `clearing resets the axis lock`() {
    val s = selected().session
    s.setLock(MoveLock.Y)
    s.clear()
    assertEquals(MoveLock.FREE, s.lock)
    s.select(item())
    s.cycleLock()
    assertEquals(MoveLock.X, s.lock)
  }

  @Test
  fun `a carry follows the poses it is given and stops at endDrag with the last one sent`() {
    val h = H()
    h.session.select(item())
    h.session.beginCarry()
    assertTrue(h.session.dragging)
    h.session.carryTo(base.copy(position = v(2, 2, 3))) // first frame goes out
    h.t += 20
    h.session.carryTo(base.copy(position = v(3, 2, 3))) // inside the interval: held back
    assertEquals(listOf(v(2, 2, 3)), h.drafts.map { it.transform.position })
    h.session.endDrag()
    assertEquals(listOf(v(2, 2, 3), v(3, 2, 3)), h.drafts.map { it.transform.position })
    assertFalse(h.session.dragging)
    h.session.carryTo(base.copy(position = v(9, 9, 9)))
    assertEquals(v(3, 2, 3), h.session.draft!!.position)
  }

  @Test
  fun `a ray drag does nothing to a carried item`() {
    val s = selected().session
    s.beginCarry()
    s.drag(down(5, 10, 5), null)
    assertEquals(base.position, s.draft!!.position)
  }
}
