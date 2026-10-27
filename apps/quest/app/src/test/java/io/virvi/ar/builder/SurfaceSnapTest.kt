package io.virvi.ar.builder

import io.virvi.ar.Vec3
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import kotlin.math.sqrt

class SurfaceSnapTest {
  private fun v(x: Double, y: Double, z: Double) = Vec3(x, y, z)

  /** A wall at z = 2 facing -z (into the room), 4 m wide and 3 m tall, its centre at 1.5 m up. */
  private val wallZ2 = Surface(SurfaceKind.WALL, v(0.0, 1.5, 2.0), v(0.0, 0.0, -1.0), 2.0, 1.5)
  /** A wall at x = 0 facing +x. */
  private val wallX0 = Surface(SurfaceKind.WALL, v(0.0, 1.5, 0.0), v(1.0, 0.0, 0.0), 2.0, 1.5)
  /** A wall at z = 0 facing +z. */
  private val wallZ0 = Surface(SurfaceKind.WALL, v(0.0, 1.5, 0.0), v(0.0, 0.0, 1.0), 2.0, 1.5)
  private val table = Surface(SurfaceKind.TABLE, v(0.0, 0.75, 0.0), v(0.0, 1.0, 0.0), 0.5, 0.4)
  private val floor = Surface(SurfaceKind.FLOOR, v(0.0, 0.0, 0.0), v(0.0, 1.0, 0.0), 3.0, 3.0)

  @Test
  fun `snaps flush to a wall and faces out`() {
    val r = snap(v(0.0, 1.5, 1.9), 30.0, 0.01, 0.5, listOf(wallZ2))
    assertEquals(SurfaceKind.WALL, r.snappedTo)
    assertEquals(1.99, r.position.z, 1e-9)
    assertEquals(0.0, r.position.x, 1e-9)
    assertEquals(1.5, r.position.y, 1e-9)
    assertEquals(180.0, r.yawDeg, 1e-9)
  }

  @Test
  fun `a wall facing +x turns the item to yaw 90`() {
    val r = snap(v(0.1, 1.5, 0.3), 0.0, 0.01, 0.5, listOf(wallX0))
    assertEquals(0.01, r.position.x, 1e-9)
    assertEquals(90.0, r.yawDeg, 1e-9)
  }

  @Test
  fun `ignores a wall 20 cm away`() {
    val r = snap(v(0.0, 1.5, 1.8), 30.0, 0.01, 0.5, listOf(wallZ2))
    assertNull(r.snappedTo)
    assertEquals(v(0.0, 1.5, 1.8), r.position)
    assertEquals(30.0, r.yawDeg, 0.0)
  }

  @Test
  fun `sits on a table`() {
    val r = snap(v(0.0, 0.8, 0.0), 30.0, 0.0, 0.1, listOf(table))
    assertEquals(SurfaceKind.TABLE, r.snappedTo)
    assertEquals(0.85, r.position.y, 1e-9)
    assertEquals(30.0, r.yawDeg, 0.0)
  }

  @Test
  fun `sits on the floor, measured from the item's underside`() {
    // Centre 0.4 m up, half height 0.3: the underside is 0.1 m off the floor.
    val r = snap(v(1.0, 0.4, 1.0), 0.0, 0.0, 0.3, listOf(floor))
    assertEquals(SurfaceKind.FLOOR, r.snappedTo)
    assertEquals(0.3, r.position.y, 1e-9)
    assertEquals(1.0, r.position.x, 0.0)
  }

  @Test
  fun `picks the nearer of two walls in a corner`() {
    val r = snap(v(0.05, 1.0, 0.1), 0.0, 0.01, 0.2, listOf(wallZ0, wallX0))
    assertEquals(SurfaceKind.WALL, r.snappedTo)
    assertEquals(0.01, r.position.x, 1e-9)
    assertEquals(0.1, r.position.z, 1e-9)
    assertEquals(90.0, r.yawDeg, 1e-9)
  }

  @Test
  fun `ignores a wall whose rectangle doesn't contain the item`() {
    // Within 15 cm of the plane, but 5 m along it from a 4 m wide wall.
    assertNull(snap(v(5.0, 1.5, 1.9), 0.0, 0.01, 0.5, listOf(wallZ2)).snappedTo)
    // And above its 3 m height.
    assertNull(snap(v(0.0, 3.5, 1.9), 0.0, 0.01, 0.5, listOf(wallZ2)).snappedTo)
  }

  @Test
  fun `a table the item is beside does not catch it`() {
    assertNull(snap(v(2.0, 0.8, 0.0), 0.0, 0.0, 0.1, listOf(table)).snappedTo)
  }

  @Test
  fun `a table with its width axis turned contains by that axis`() {
    // 0.5 m half width along z, 0.1 m along x.
    val t = Surface(SurfaceKind.TABLE, v(0.0, 0.75, 0.0), v(0.0, 1.0, 0.0), 0.5, 0.1, v(0.0, 0.0, 1.0))
    assertEquals(SurfaceKind.TABLE, snap(v(0.0, 0.8, 0.4), 0.0, 0.0, 0.1, listOf(t)).snappedTo)
    assertNull(snap(v(0.4, 0.8, 0.0), 0.0, 0.0, 0.1, listOf(t)).snappedTo)
  }

  @Test
  fun `the nearest of a floor and a table wins`() {
    val r = snap(v(0.0, 0.8, 0.0), 0.0, 0.0, 0.1, listOf(floor, table))
    assertEquals(SurfaceKind.TABLE, r.snappedTo)
  }

  @Test
  fun `nothing to snap to leaves the pose alone`() {
    val r = snap(v(1.0, 2.0, 3.0), 45.0, 0.01, 0.1, emptyList())
    assertNull(r.snappedTo)
    assertEquals(SnapResult(v(1.0, 2.0, 3.0), 45.0, null), r)
  }

  @Test
  fun `room plane data becomes a surface, horizontal ones facing up`() {
    val s = surfaceOf(SurfaceKind.TABLE, v(1.0, 0.75, 1.0), v(0.0, -1.0, 0.0), v(0.0, 0.0, 1.0), 0.5, 0.4)
    assertEquals(v(0.0, 1.0, 0.0), s.normal)
    assertEquals(v(0.0, 0.0, 1.0), s.widthAxis)
    val w = surfaceOf(SurfaceKind.WALL, v(0.0, 1.5, 2.0), v(0.0, 0.0, -1.0), v(1.0, 0.0, 0.0), 2.0, 1.5)
    assertEquals(v(0.0, 0.0, -1.0), w.normal)
  }

  @Test
  fun `a flat item is thin and sits at its centre, a model rests on its origin`() {
    val flat = snapExtents("image", v(2.0, 1.0, 1.0))
    assertEquals(FLAT_HALF_DEPTH_M, flat.halfDepth, 0.0)
    assertEquals(0.5, flat.halfHeight, 0.0)
    val model = snapExtents("model", v(1.0, 2.0, 0.5))
    assertEquals(0.25, model.halfDepth, 0.0)
    assertEquals(0.0, model.halfHeight, 0.0)
  }

  @Test
  fun `a wall at 45 degrees takes the item flush and faces out`() {
    val h = sqrt(0.5)
    val wall = Surface(SurfaceKind.WALL, v(0.0, 1.5, 0.0), v(h, 0.0, h), 3.0, 1.5)
    val r = snap(v(0.05, 1.5, 0.05), 0.0, 0.01, 0.5, listOf(wall))
    assertEquals(SurfaceKind.WALL, r.snappedTo)
    assertEquals(45.0, r.yawDeg, 1e-9)
    assertEquals(0.01 * h, r.position.x, 1e-9)
    assertEquals(0.01 * h, r.position.z, 1e-9)
    assertEquals(1.5, r.position.y, 1e-9)
  }

  @Test
  fun `an item up to 15 cm behind a wall comes out to its front face`() {
    val r = snap(v(0.0, 1.5, 2.1), 30.0, 0.01, 0.5, listOf(wallZ2))
    assertEquals(SurfaceKind.WALL, r.snappedTo)
    assertEquals(1.99, r.position.z, 1e-9)
    assertEquals(180.0, r.yawDeg, 1e-9)
  }
}
