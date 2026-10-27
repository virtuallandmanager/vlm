package io.virvi.ar.builder

import io.virvi.ar.Quat
import io.virvi.ar.Vec3
import io.virvi.ar.space.RootPose
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.sqrt

class CarryTest {
  private fun v(x: Double, y: Double, z: Double) = Vec3(x, y, z)

  private fun yaw(deg: Double) = Quat.axisAngle(0.0, 1.0, 0.0, Math.toRadians(deg))

  private fun near(a: Vec3, b: Vec3) {
    assertEquals(a.x, b.x, 1e-9)
    assertEquals(a.y, b.y, 1e-9)
    assertEquals(a.z, b.z, 1e-9)
  }

  private fun sameTurn(a: Quat, b: Quat) {
    // q and -q are the same turn.
    val dot = a.w * b.w + a.x * b.x + a.y * b.y + a.z * b.z
    assertEquals(1.0, Math.abs(dot), 1e-9)
  }

  @Test
  fun `the item holds its place until the controller moves`() {
    val item = WorldPose(v(1.0, 1.0, 2.0), yaw(20.0))
    val c = Carry()
    c.start(item, WorldPose(v(0.0, 1.0, 0.5), yaw(-30.0)))
    val out = c.update(WorldPose(v(0.0, 1.0, 0.5), yaw(-30.0)))
    near(item.position, out.position)
    sameTurn(item.rotation, out.rotation)
  }

  @Test
  fun `moving the controller moves the item by the same amount`() {
    val c = Carry()
    c.start(WorldPose(v(1.0, 1.0, 2.0), Quat.IDENTITY), WorldPose(v(0.0, 1.0, 0.5), Quat.IDENTITY))
    near(v(1.5, 1.2, 2.0), c.update(WorldPose(v(0.5, 1.2, 0.5), Quat.IDENTITY)).position)
  }

  @Test
  fun `turning the controller swings the item round it and turns it the same`() {
    val c = Carry()
    c.start(WorldPose(v(0.0, 1.0, 1.0), Quat.IDENTITY), WorldPose(v(0.0, 1.0, 0.0), Quat.IDENTITY))
    // 90 degrees about +Y turns +Z into +X.
    val out = c.update(WorldPose(v(0.0, 1.0, 0.0), yaw(90.0)))
    near(v(1.0, 1.0, 0.0), out.position)
    sameTurn(yaw(90.0), out.rotation)
  }

  @Test
  fun `a flick turns the item about the vertical axis, in place`() {
    val c = Carry()
    c.start(WorldPose(v(0.0, 1.0, 1.0), Quat.IDENTITY), WorldPose(v(0.0, 1.0, 0.0), Quat.IDENTITY))
    c.turn(CARRY_TURN_DEGREES)
    val out = c.update(WorldPose(v(0.0, 1.0, 0.0), Quat.IDENTITY))
    near(v(0.0, 1.0, 1.0), out.position)
    sameTurn(yaw(15.0), out.rotation)
    c.turn(-CARRY_TURN_DEGREES)
    c.turn(-CARRY_TURN_DEGREES)
    sameTurn(yaw(-15.0), c.update(WorldPose(v(0.0, 1.0, 0.0), Quat.IDENTITY)).rotation)
  }

  @Test
  fun `a new start forgets the old turn`() {
    val c = Carry()
    c.start(WorldPose(v(0.0, 0.0, 1.0), Quat.IDENTITY), WorldPose(v(0.0, 0.0, 0.0), Quat.IDENTITY))
    c.turn(15.0)
    c.start(WorldPose(v(0.0, 0.0, 1.0), Quat.IDENTITY), WorldPose(v(0.0, 0.0, 0.0), Quat.IDENTITY))
    sameTurn(Quat.IDENTITY, c.update(WorldPose(v(0.0, 0.0, 0.0), Quat.IDENTITY)).rotation)
  }

  @Test
  fun `a scene transform goes to world and back through the root pose`() {
    val root = RootPose(v(3.0, 0.0, -2.0), 90.0)
    val t = ItemTransform(v(1.0, 0.5, 2.0), v(10.0, 40.0, 5.0), v(1.0, 2.0, 3.0))
    val world = worldPoseOf(t, root)
    // R_y(90) turns scene (1, _, 2) into (2, _, -1), then the root's position.
    near(v(5.0, 0.5, -3.0), world.position)
    val back = world.toScene(root, t.scale)
    near(t.position, back.position)
    assertTrue(TransformMath.sameTransform(t, back))
  }

  @Test
  fun `landing without snapping keeps the carried pose in scene coordinates`() {
    val root = RootPose(v(3.0, 0.0, -2.0), 90.0)
    val t = ItemTransform(v(1.0, 0.5, 2.0), v(0.0, 40.0, 0.0), v(1.0, 1.0, 1.0))
    val out = landCarried(worldPoseOf(t, root), "image", t.scale, root, emptyList(), snapOn = false)
    assertTrue(TransformMath.sameTransform(t, out))
  }

  @Test
  fun `landing on a wall puts the item flush, upright and facing out, in scene coordinates`() {
    // The scene is turned 90 degrees and moved; the wall is at world z = 2 facing -z.
    val root = RootPose(v(0.0, 0.0, 0.0), 90.0)
    val wall = Surface(SurfaceKind.WALL, v(0.0, 1.5, 2.0), v(0.0, 0.0, -1.0), 2.0, 1.5)
    val carried = WorldPose(v(0.2, 1.5, 1.9), Quat.axisAngle(1.0, 0.0, 0.0, Math.toRadians(20.0)))
    val out = landCarried(carried, "image", v(1.0, 1.0, 1.0), root, listOf(wall), snapOn = true)
    // World (0.2, 1.5, 1.99) is scene R_y(-90) of it: (x, z) -> (-1.99 .. ) checked by the way back.
    val back = worldPoseOf(out, root)
    near(v(0.2, 1.5, 2.0 - FLAT_HALF_DEPTH_M), back.position)
    // Facing out: world yaw 180, so scene yaw 90; no pitch or roll left.
    assertEquals(90.0, out.rotation.y, 1e-6)
    assertEquals(0.0, out.rotation.x, 1e-6)
    assertEquals(0.0, out.rotation.z, 1e-6)
  }

  @Test
  fun `landing with snapping off leaves a pose next to a wall alone`() {
    val root = RootPose(v(0.0, 0.0, 0.0), 0.0)
    val wall = Surface(SurfaceKind.WALL, v(0.0, 1.5, 2.0), v(0.0, 0.0, -1.0), 2.0, 1.5)
    val carried = WorldPose(v(0.0, 1.5, 1.9), Quat.IDENTITY)
    val off = landCarried(carried, "image", v(1.0, 1.0, 1.0), root, listOf(wall), snapOn = false)
    assertEquals(1.9, off.position.z, 1e-9)
  }

  @Test
  fun `landing a model on a table puts its origin on the top`() {
    val root = RootPose(v(0.0, 0.0, 0.0), 0.0)
    val table = Surface(SurfaceKind.TABLE, v(0.0, 0.75, 0.0), v(0.0, 1.0, 0.0), 0.5, 0.4)
    val out = landCarried(WorldPose(v(0.1, 0.8, 0.1), yaw(33.0)), "model", v(1.0, 1.0, 1.0), root, listOf(table), true)
    assertEquals(0.75, out.position.y, 1e-9)
    assertEquals(33.0, out.rotation.y, 1e-6)
  }

  @Test
  fun `a controller ray points at an item when it passes near its middle`() {
    val ray = Ray(v(0.0, 1.0, 0.0), v(0.0, 0.0, 1.0))
    assertTrue(rayNearItem(ray, v(0.1, 1.0, 2.0), 0.3))
    assertFalse(rayNearItem(ray, v(1.0, 1.0, 2.0), 0.3))
    // Behind the controller.
    assertFalse(rayNearItem(ray, v(0.0, 1.0, -2.0), 0.3))
  }

  @Test
  fun `the grab radius is half the item's diagonal plus some slack`() {
    assertEquals(0.5 * sqrt(3.0) + CARRY_GRAB_SLACK_M, carryGrabRadius(v(1.0, 1.0, 1.0)), 1e-9)
    assertEquals(0.5 * sqrt(3.0) + CARRY_GRAB_SLACK_M, carryGrabRadius(v(-1.0, 1.0, -1.0)), 1e-9)
  }
}
