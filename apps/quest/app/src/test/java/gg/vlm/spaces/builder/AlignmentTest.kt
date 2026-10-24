package gg.vlm.spaces.builder

import com.meta.spatial.core.Vector3
import gg.vlm.spaces.Vec3
import gg.vlm.spaces.api.BuilderCall
import gg.vlm.spaces.ring.WallPlane
import gg.vlm.spaces.space.angleDiffDeg
import gg.vlm.spaces.space.markerInScene
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AlignmentTest {
  private val ring = Vec3(2.0, 1.4, -3.0)
  private val heading = 135.0

  @Test fun `defaultRoot puts the ring at scene 8, h, 0 facing north`() {
    val p = markerInScene(defaultRoot(ring, heading, 0.0, 1.5), ring, heading)
    assertEquals(8.0, p.x, 1e-9)
    assertEquals(1.5, p.y, 1e-9)
    assertEquals(0.0, p.z, 1e-9)
    assertEquals(0.0, p.headingDeg, 1e-9)
  }

  @Test fun `defaultRoot adds the floor height`() {
    assertEquals(4.5, markerInScene(defaultRoot(ring, heading, 3.0, 1.5), ring, heading).y, 1e-9)
  }

  @Test fun `nudge turns about the ring`() {
    val root = defaultRoot(ring, heading, 0.0, 1.5)
    val turned = nudge(root, 0.0, 0.0, 10.0, ring)
    val before = markerInScene(root, ring, heading)
    val after = markerInScene(turned, ring, heading)
    assertEquals(before.x, after.x, 1e-9)
    assertEquals(before.y, after.y, 1e-9)
    assertEquals(before.z, after.z, 1e-9)
    assertEquals(-10.0, angleDiffDeg(after.headingDeg, before.headingDeg), 1e-9)
  }

  @Test fun `nudge moves the scene in world x and z only`() {
    val root = defaultRoot(ring, heading, 0.0, 1.5)
    val moved = nudge(root, 0.01, -0.02, 0.0, ring)
    assertEquals(root.position.x + 0.01, moved.position.x, 1e-12)
    assertEquals(root.position.y, moved.position.y, 1e-12)
    assertEquals(root.position.z - 0.02, moved.position.z, 1e-12)
    assertEquals(root.yawDeg, moved.yawDeg, 1e-12)
  }

  @Test fun `sizeRatio and sizeWarning`() {
    assertEquals(1.5, sizeRatio(1.5, 1.0), 1e-12)
    assertNull(sizeWarning(1.02))
    assertNull(sizeWarning(0.98))
    assertNull(sizeWarning(1.0))
    assertEquals("This ring looks about 8% smaller than its recorded size: was it printed at 100%?", sizeWarning(1.087))
    assertEquals("This ring looks about 5% larger than its recorded size: was it printed at 100%?", sizeWarning(0.95))
  }

  @Test fun `sizeWarning ignores a ratio that is not a number`() {
    assertNull(sizeWarning(Double.NaN))
    assertNull(sizeWarning(0.0))
    assertNull(sizeWarning(Double.POSITIVE_INFINITY))
  }

  // ── the depth range ──

  @Test fun `rangeToPlane is the distance along the ray`() {
    // A wall at z = 3 facing -z; the ray leans 60° from the normal, so the range is 3 / cos 60° = 6.
    val dir = Vec3(Math.sin(Math.PI / 3), 0.0, Math.cos(Math.PI / 3))
    assertEquals(6.0, rangeToPlane(Vec3(0.0, 1.6, 0.0), dir, Vec3(0.0, 1.0, 3.0), Vec3(0.0, 0.0, -1.0))!!, 1e-9)
  }

  @Test fun `rangeToPlane is null for a parallel ray or a plane behind`() {
    val n = Vec3(0.0, 0.0, -1.0)
    assertNull(rangeToPlane(Vec3(0.0, 0.0, 0.0), Vec3(1.0, 0.0, 0.0), Vec3(0.0, 0.0, 3.0), n))
    assertNull(rangeToPlane(Vec3(0.0, 0.0, 0.0), Vec3(0.0, 0.0, -1.0), Vec3(0.0, 0.0, 3.0), n))
  }

  private fun wall(cx: Float, cz: Float, nx: Float, nz: Float) = WallPlane(Vector3(cx, 1.25f, cz), Vector3(nx, 0f, nz), 2f, 1.25f)

  @Test fun `depthRange uses the wall the ring is on`() {
    val walls = listOf(wall(0f, 3f, 0f, -1f), wall(2f, 0f, -1f, 0f))
    val eye = Vec3(0.0, 1.6, 0.0)
    val onFront = Vec3(0.5, 1.5, 3.0)
    val dx = onFront.x - eye.x
    val dy = onFront.y - eye.y
    val dz = onFront.z - eye.z
    assertEquals(Math.sqrt(dx * dx + dy * dy + dz * dz), depthRange(eye, onFront, walls)!!, 1e-6)
  }

  @Test fun `depthRange is null with no wall under the ring`() {
    assertNull(depthRange(Vec3(0.0, 1.6, 0.0), Vec3(0.5, 1.5, 1.0), listOf(wall(0f, 3f, 0f, -1f))))
  }

  // ── the flow ──

  private val sight = RingSight(Vec3(2.0, 1.4, -3.0), 90.0, 1.0)

  private fun placed(): AlignFlow = AlignFlow("Ground floor", 0.0).also { it.onSteadyRing(sight) }

  @Test fun `starts looking at the ring and places the scene when it is steady and near`() {
    val f = AlignFlow("Ground floor", 0.0)
    assertEquals(AlignState.LookAtRing, f.state)
    f.onSteadyRing(sight.copy(distanceM = 1.6))
    assertEquals(AlignState.LookAtRing, f.state)
    f.onSteadyRing(sight)
    val s = f.state as AlignState.Placed
    assertEquals(8.0, markerInScene(s.root, sight.world, sight.headingDeg).x, 1e-9)
    assertEquals(1.4, markerInScene(s.root, sight.world, sight.headingDeg).y, 1e-9)
  }

  @Test fun `a later sighting does not move a placed scene`() {
    val f = placed()
    val root = (f.state as AlignState.Placed).root
    f.onSteadyRing(sight.copy(world = Vec3(0.0, 0.0, 0.0)))
    assertEquals(root, (f.state as AlignState.Placed).root)
  }

  @Test fun `nudging turns about the ring`() {
    val f = placed()
    val start = markerInScene((f.state as AlignState.Placed).root, sight.world, sight.headingDeg)
    f.nudge(0.0, 0.0, 5.0)
    val p = markerInScene((f.state as AlignState.Placed).root, sight.world, sight.headingDeg)
    assertEquals(8.0, p.x, 1e-9)
    assertEquals(-5.0, angleDiffDeg(p.headingDeg, start.headingDeg), 1e-9)
  }

  @Test fun `save beyond 1_5 m is refused and the scene stays adjustable`() {
    val f = placed()
    assertNull(f.requestSave(1.51))
    assertEquals(AlignState.Refused("Step closer to the ring to save"), f.state)
    f.nudge(0.01, 0.0, 0.0)
    assertTrue(f.state is AlignState.Placed)
    assertNotNull(f.requestSave(1.5))
  }

  @Test fun `save gives the ring's scene pose and its height above the floor`() {
    val f = placed()
    f.nudge(0.0, 0.0, 10.0)
    val root = (f.state as AlignState.Placed).root
    val req = f.requestSave(1.0)!!
    assertEquals(AlignState.Saving, f.state)
    assertEquals(markerInScene(root, sight.world, sight.headingDeg), req.pose)
    assertEquals(1.4, req.heightAboveFloorM, 1e-12)
  }

  @Test fun `save before the scene is placed gives nothing`() {
    assertNull(AlignFlow("Ground floor", 0.0).requestSave(1.0))
  }

  @Test fun `a saved answer carries its warnings as copy`() {
    val f = AlignFlow("Mezzanine", 3.5).also { it.onSteadyRing(sight) }
    f.requestSave(1.0)
    f.saved(BuilderCall.Ok(listOf("floor_height_off", "something_new")))
    assertEquals(AlignState.Saved(listOf("floor_height_off", "something_new")), f.state)
    assertEquals(listOf("Floor height doesn't match Mezzanine (3.5 m): check the floor"), f.warningLines())
  }

  @Test fun `a failed save is refused with a reason and can be tried again`() {
    val f = placed()
    f.requestSave(1.0)
    f.saved(BuilderCall.NoAccess)
    assertEquals(AlignState.Refused("This account can't edit this scene"), f.state)
    assertNotNull(f.requestSave(1.0))
    f.saved(BuilderCall.Offline)
    assertTrue((f.state as AlignState.Refused).reason.isNotEmpty())
  }

  @Test fun `the size check runs once per alignment`() {
    val f = placed()
    assertNull(f.sizeMessage)
    f.checkSize(1.087, 1.0)
    assertEquals("This ring looks about 8% smaller than its recorded size: was it printed at 100%?", f.sizeMessage)
    f.checkSize(1.0, 1.0)
    assertNotNull(f.sizeMessage)
  }

  @Test fun `the size check with no depth range is skipped but not spent`() {
    val f = placed()
    f.checkSize(1.0, null)
    f.checkSize(1.087, 1.0)
    assertNotNull(f.sizeMessage)
  }

  // ── the sticks ──

  @Test fun `stick steps are 1 cm and half a degree with the grip held`() {
    val s = stickNudge(0.0, 1.0, 1.0, 0.0, fine = true)
    assertEquals(0.0, s.dx, 1e-12)
    assertEquals(0.01, s.dz, 1e-12)
    assertEquals(0.5, s.dYawDeg, 1e-12)
  }

  @Test fun `left stick moves relative to where the head faces`() {
    // Facing +x (heading 90°): forward is +x, right is -z.
    val fwd = stickNudge(0.0, 1.0, 0.0, 90.0, fine = true)
    assertEquals(0.01, fwd.dx, 1e-12)
    assertEquals(0.0, fwd.dz, 1e-12)
    val right = stickNudge(1.0, 0.0, 0.0, 90.0, fine = true)
    assertEquals(0.0, right.dx, 1e-12)
    assertEquals(-0.01, right.dz, 1e-12)
  }

  @Test fun `a stick near the middle does nothing`() {
    assertEquals(StickNudge(0.0, 0.0, 0.0), stickNudge(0.2, -0.2, 0.3, 0.0, fine = false))
  }
}
