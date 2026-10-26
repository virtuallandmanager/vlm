package io.virvi.ar.space

import io.virvi.ar.Quat
import io.virvi.ar.Vec3
import io.virvi.ar.api.MarkerPose
import kotlin.math.PI
import kotlin.random.Random
import org.junit.Assert.assertEquals
import org.junit.Test

class SpaceAlignmentTest {
  private val eps = 1e-9

  private fun assertVec(expected: Vec3, actual: Vec3) {
    assertEquals(expected.x, actual.x, eps)
    assertEquals(expected.y, actual.y, eps)
    assertEquals(expected.z, actual.z, eps)
  }

  /** Where a scene point lands in the world. */
  private fun toWorld(root: RootPose, s: Vec3): Vec3 {
    val r = Quat.axisAngle(0.0, 1.0, 0.0, root.yawDeg * PI / 180).rotate(s)
    return Vec3(root.position.x + r.x, root.position.y + r.y, root.position.z + r.z)
  }

  @Test
  fun identity() {
    val root = rootFromMarker(Vec3(8.0, 1.5, 0.0), 0.0, MarkerPose(8.0, 1.5, 0.0, 0.0))
    assertVec(Vec3(0.0, 0.0, 0.0), root.position)
    assertEquals(0.0, root.yawDeg, eps)
  }

  @Test
  fun `turned and moved`() {
    val root = rootFromMarker(Vec3(1.0, 1.5, 2.0), 90.0, MarkerPose(8.0, 1.5, 0.0, 0.0))
    assertEquals(90.0, root.yawDeg, eps)
    assertVec(Vec3(1.0, 1.5, 2.0), toWorld(root, Vec3(8.0, 1.5, 0.0)))
    assertVec(Vec3(2.0, 1.5, 2.0), toWorld(root, Vec3(8.0, 1.5, 1.0)))
  }

  @Test
  fun `round trip`() {
    val rnd = Random(42)
    repeat(50) {
      val w = Vec3(rnd.nextDouble(-20.0, 20.0), rnd.nextDouble(0.0, 3.0), rnd.nextDouble(-20.0, 20.0))
      val h = rnd.nextDouble(-360.0, 360.0)
      val s = MarkerPose(rnd.nextDouble(0.0, 16.0), rnd.nextDouble(0.0, 3.0), rnd.nextDouble(0.0, 16.0), rnd.nextDouble(0.0, 360.0))
      val back = markerInScene(rootFromMarker(w, h, s), w, h)
      assertEquals(s.x, back.x, eps)
      assertEquals(s.y, back.y, eps)
      assertEquals(s.z, back.z, eps)
      assertEquals(0.0, angleDiffDeg(s.headingDeg, back.headingDeg), eps)
    }
  }

  @Test
  fun `heading wraps`() {
    val root = rootFromMarker(Vec3(0.0, 0.0, 0.0), 10.0, MarkerPose(0.0, 0.0, 0.0, 350.0))
    assertEquals(20.0, angleDiffDeg(root.yawDeg, 0.0), eps)
  }

  @Test
  fun angleDiff() {
    assertEquals(20.0, angleDiffDeg(10.0, 350.0), eps)
    assertEquals(-20.0, angleDiffDeg(350.0, 10.0), eps)
    assertEquals(180.0, angleDiffDeg(0.0, 180.0), eps)
  }
}
