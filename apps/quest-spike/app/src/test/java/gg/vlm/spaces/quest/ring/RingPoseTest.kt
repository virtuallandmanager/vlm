package gg.vlm.spaces.quest.ring

import com.meta.spatial.core.Pose
import com.meta.spatial.core.Quaternion
import com.meta.spatial.core.Vector3
import gg.vlm.spaces.quest.Vec3
import kotlin.math.sqrt
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class RingPoseTest {
  private val ring140 = RING_TEST_MARKERS.first { it.name == "RING140" }
  /** Principal point at the stream centre, no lens offset. */
  private val k = CameraIntrinsics(760.0, 760.0, 640.0, 480.0, FloatArray(0), FloatArray(0))

  private fun det(cx: Double, cy: Double, semiMajor: Double) =
      RingDetection(ring140.id, 0, 0, cx, cy, semiMajor, semiMajor * 0.95, 0.0, 0.0)

  private fun len(v: Vec3) = sqrt(v.x * v.x + v.y * v.y + v.z * v.z)

  @Test
  fun distanceFromSize() {
    val p = markerInCamera(det(700.0, 400.0, 59.1), k, ring140.diameter)
    assertEquals(0.90, len(p), 0.01)
  }

  @Test
  fun rayThroughCentre() {
    val p = markerInCamera(det(640.0, 480.0, 59.1), k, ring140.diameter)
    val d = 760.0 * 0.07 / 59.1
    assertEquals(0.0, p.x, 1e-9)
    assertEquals(0.0, p.y, 1e-9)
    assertEquals(d, p.z, 1e-9)
  }

  @Test
  fun rayOffCentreIsRightAndDown() {
    // A centre right of and below the principal point is +x, +y in camera space.
    val p = markerInCamera(det(640.0 + 76.0, 480.0 + 38.0, 59.1), k, ring140.diameter)
    assertEquals(0.1, p.x / p.z, 1e-9)
    assertEquals(0.05, p.y / p.z, 1e-9)
  }

  /** Two walls meeting at a corner: one along x at z = 3 facing -z, one along z at x = 2 facing -x. */
  private val walls =
      listOf(
          WallPlane(Vector3(0f, 1.5f, 3f), Vector3(0f, 0f, -1f), 2f, 1.5f),
          WallPlane(Vector3(2f, 1.5f, 0f), Vector3(-1f, 0f, 0f), 3f, 1.5f),
      )
  private val viewer = Vector3(0f, 1.6f, 0f)

  @Test
  fun wallHeadingNearest() {
    // 5 cm in front of the z = 3 wall: its normal is -z, yaw 180°.
    assertEquals(180.0, wallHeading(Vector3(0.5f, 1.5f, 2.95f), walls, viewer)!!, 1e-4)
    // 5 cm in front of the x = 2 wall: normal -x, yaw -90°.
    assertEquals(-90.0, wallHeading(Vector3(1.95f, 1.2f, 0.5f), walls, viewer)!!, 1e-4)
    // 30 cm from both.
    assertNull(wallHeading(Vector3(1.7f, 1.5f, 2.7f), walls, viewer))
    // On the z = 3 plane but past its end.
    assertNull(wallHeading(Vector3(-2.5f, 1.5f, 3f), walls, viewer))
  }

  @Test
  fun wallNormalIntoRoom() {
    // The same z = 3 wall, its normal reported pointing away from the viewer (+z): flipped back to -z.
    val away = listOf(WallPlane(Vector3(0f, 1.5f, 3f), Vector3(0f, 0f, 1f), 2f, 1.5f))
    assertEquals(180.0, wallHeading(Vector3(0.5f, 1.5f, 3.02f), away, viewer)!!, 1e-4)
    // Seen from the other side of that wall, the normal points +z (yaw 0°).
    assertEquals(0.0, wallHeading(Vector3(0.5f, 1.5f, 3.02f), away, Vector3(0f, 1.6f, 5f))!!, 1e-4)
  }

  @Test
  fun cameraToWorldIdentityLensFollowsHead() {
    // No lens pose: camera space (+y down) maps to head space (+y up), then the head pose.
    val head = Pose(Vector3(1f, 1.6f, 0f), Quaternion(0.70710677f, 0f, 0.70710677f, 0f)) // yaw 90°: head +z is world +x
    val w = cameraToWorld(Vec3(0.0, 0.1, 1.0), head, k)
    assertEquals(2.0, w.x.toDouble(), 1e-5)
    assertEquals(1.5, w.y.toDouble(), 1e-5)
    assertEquals(0.0, w.z.toDouble(), 1e-5)
  }

  @Test
  fun cameraToWorldAppliesAndroidLensPose() {
    // Android LENS_POSE: rotation (x, y, z, w) from the sensor frame (x right, y up, z toward the user) to the camera
    // frame (x right, y down, z forward); a forward-looking camera is 180° about x. Translation is in the sensor frame.
    val lens = CameraIntrinsics(760.0, 760.0, 640.0, 480.0, floatArrayOf(-0.03f, 0.01f, 0.02f), floatArrayOf(1f, 0f, 0f, 0f))
    val w = cameraToWorld(Vec3(0.0, 0.0, 1.0), Pose(), lens)
    // Sensor point = (−0.03, 0.01, 0.02) + (0, 0, −1); to Spatial SDK (z forward) = (−0.03, 0.01, 0.98).
    assertEquals(-0.03, w.x.toDouble(), 1e-5)
    assertEquals(0.01, w.y.toDouble(), 1e-5)
    assertEquals(0.98, w.z.toDouble(), 1e-5)
  }

  @Test
  fun intrinsicsScaledFromReferenceSize() {
    val raw = CameraIntrinsics(1520.0, 1520.0, 1280.0, 960.0, FloatArray(0), FloatArray(0))
    // Same aspect, twice the size: plain halving.
    val half = scaleIntrinsics(raw, 2560, 1920, 1280, 960)
    assertEquals(760.0, half.fx, 1e-9)
    assertEquals(760.0, half.fy, 1e-9)
    assertEquals(640.0, half.cx, 1e-9)
    assertEquals(480.0, half.cy, 1e-9)
    // A square 1280 x 1280 reference read at 4:3: the middle 960 rows, no scale.
    val sq = CameraIntrinsics(760.0, 760.0, 640.0, 640.0, FloatArray(0), FloatArray(0))
    val crop = scaleIntrinsics(sq, 1280, 1280, 1280, 960)
    assertEquals(760.0, crop.fx, 1e-9)
    assertEquals(640.0, crop.cx, 1e-9)
    assertEquals(480.0, crop.cy, 1e-9)
    // Already at the stream size: unchanged.
    assertEquals(k, scaleIntrinsics(k, 1280, 960, 1280, 960))
  }
}
