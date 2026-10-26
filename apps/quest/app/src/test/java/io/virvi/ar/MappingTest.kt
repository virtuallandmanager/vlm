package io.virvi.ar

import com.meta.spatial.core.Quaternion
import com.meta.spatial.core.Vector3
import org.junit.Assert.assertEquals
import org.junit.Test

class MappingTest {
  private fun close(a: Vec3, b: Vec3) {
    assertEquals(b.x, a.x, 1e-6)
    assertEquals(b.y, a.y, 1e-6)
    assertEquals(b.z, a.z, 1e-6)
  }

  @Test
  fun positionAndScaleCarryOver() {
    val t = toSpatialTransform(Vec3(1.0, 2.0, 3.0), Vec3(0.0, 0.0, 0.0), Vec3(2.0, 3.0, 4.0))
    assertEquals(Vec3(1.0, 2.0, 3.0), t.position)
    assertEquals(Vec3(2.0, 3.0, 4.0), t.scale)
  }

  @Test
  fun a90DegreeYawTurnsForwardToTheRight() {
    // In Decentraland, forward (0,0,1) yawed 90° is (1,0,0).
    close(Quat.yxzDegrees(Vec3(0.0, 90.0, 0.0)).rotate(Vec3(0.0, 0.0, 1.0)), Vec3(1.0, 0.0, 0.0))
  }

  @Test
  fun yxzOrderAppliesRollThenPitchThenYaw() {
    val q = Quat.yxzDegrees(Vec3(20.0, 135.0, -10.0))
    val manual =
        Quat.axisAngle(0.0, 1.0, 0.0, Math.toRadians(135.0)) *
            Quat.axisAngle(1.0, 0.0, 0.0, Math.toRadians(20.0)) *
            Quat.axisAngle(0.0, 0.0, 1.0, Math.toRadians(-10.0))
    close(q.rotate(Vec3(0.3, -2.0, 5.0)), manual.rotate(Vec3(0.3, -2.0, 5.0)))
  }

  @Test
  fun spatialSdkQuaternionTakesWxyzAndRotatesTheSameWay() {
    val q = Quat.yxzDegrees(Vec3(20.0, 135.0, -10.0))
    val sdk = Quaternion(q.w.toFloat(), q.x.toFloat(), q.y.toFloat(), q.z.toFloat())
    val v = sdk.times(Vector3(0.3f, -2f, 5f))
    val expected = q.rotate(Vec3(0.3, -2.0, 5.0))
    assertEquals(expected.x, v.x.toDouble(), 1e-4)
    assertEquals(expected.y, v.y.toDouble(), 1e-4)
    assertEquals(expected.z, v.z.toDouble(), 1e-4)
  }
}
