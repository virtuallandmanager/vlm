package io.virvi.ar.ring

import com.meta.spatial.core.Pose
import com.meta.spatial.core.Quaternion
import com.meta.spatial.core.Vector3
import io.virvi.ar.Vec3
import io.virvi.ar.Quat
import io.virvi.ar.sdk
import io.virvi.ar.visitor.lockHeading
import java.io.File
import kotlin.math.acos
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RingPoseTest {
  private val ring140 = RING_TEST_MARKERS.first { it.name == "RING140" }
  /** Principal point at the stream centre, no lens offset. */
  private val k = CameraIntrinsics(testsetFocalPx, testsetFocalPx, 640.0, 480.0, FloatArray(0), FloatArray(0))

  private fun det(cx: Double, cy: Double, semiMajor: Double) =
      RingDetection(ring140.id, 0, 0, cx, cy, semiMajor, semiMajor * 0.95, 0.0, 0.0)

  private fun len(v: Vec3) = sqrt(v.x * v.x + v.y * v.y + v.z * v.z)

  @Test
  fun distanceFromSize() {
    // The semi-major a 0.14 m marker has at 0.90 m: f * (D / 2) / d.
    val p = markerInCamera(det(700.0, 400.0, testsetFocalPx * 0.07 / 0.90), k, ring140.diameter)
    assertEquals(0.90, len(p), 0.01)
  }

  @Test
  fun rayThroughCentre() {
    val semiMajor = 59.1
    val p = markerInCamera(det(640.0, 480.0, semiMajor), k, ring140.diameter)
    val d = testsetFocalPx * 0.07 / semiMajor
    assertEquals(0.0, p.x, 1e-9)
    assertEquals(0.0, p.y, 1e-9)
    assertEquals(d, p.z, 1e-9)
  }

  @Test
  fun rayOffCentreIsRightAndDown() {
    // A centre right of and below the principal point is +x, +y in camera space.
    val p = markerInCamera(det(640.0 + 0.1 * testsetFocalPx, 480.0 + 0.05 * testsetFocalPx, 59.1), k, ring140.diameter)
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
    assertEquals(180.0, wallHeading(Vector3(0.5f, 1.5f, 2.95f), walls, viewer, null)!!, 1e-4)
    // 5 cm in front of the x = 2 wall: normal -x, yaw -90°.
    assertEquals(-90.0, wallHeading(Vector3(1.95f, 1.2f, 0.5f), walls, viewer, null)!!, 1e-4)
    // 30 cm in front of the z = 3 wall (a print 10% off size): the ray from the viewer still meets that wall first.
    assertEquals(180.0, wallHeading(Vector3(1.7f, 1.5f, 2.7f), walls, viewer, null)!!, 1e-4)
    // Far short of any wall (a print off size by far more than a misprint): no wall.
    assertNull(wallHeading(Vector3(0.5f, 1.5f, 1.0f), walls, viewer, null))
    // On the z = 3 plane but past its end.
    assertNull(wallHeading(Vector3(-2.5f, 1.5f, 3f), walls, viewer, null))
  }

  @Test
  fun wallNormalIntoRoom() {
    // The same z = 3 wall, its normal reported pointing away from the viewer (+z): flipped back to -z.
    val away = listOf(WallPlane(Vector3(0f, 1.5f, 3f), Vector3(0f, 0f, 1f), 2f, 1.5f))
    assertEquals(180.0, wallHeading(Vector3(0.5f, 1.5f, 3.02f), away, viewer, null)!!, 1e-4)
    // Seen from the other side of that wall, the normal points +z (yaw 0°).
    assertEquals(0.0, wallHeading(Vector3(0.5f, 1.5f, 3.02f), away, Vector3(0f, 1.6f, 5f), null)!!, 1e-4)
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
    val lens = CameraIntrinsics(testsetFocalPx, testsetFocalPx, 640.0, 480.0, floatArrayOf(-0.03f, 0.01f, 0.02f), floatArrayOf(1f, 0f, 0f, 0f))
    val w = cameraToWorld(Vec3(0.0, 0.0, 1.0), Pose(), lens)
    // Sensor point = (−0.03, 0.01, 0.02) + (0, 0, −1); to Spatial SDK (z forward) = (−0.03, 0.01, 0.98).
    assertEquals(-0.03, w.x.toDouble(), 1e-5)
    assertEquals(0.01, w.y.toDouble(), 1e-5)
    assertEquals(0.98, w.z.toDouble(), 1e-5)
  }

  @Test
  fun intrinsicsScaledFromReferenceSize() {
    val raw = CameraIntrinsics(2 * testsetFocalPx, 2 * testsetFocalPx, 1280.0, 960.0, FloatArray(0), FloatArray(0))
    // Same aspect, twice the size: plain halving.
    val half = scaleIntrinsics(raw, 2560, 1920, 1280, 960)
    assertEquals(testsetFocalPx, half.fx, 1e-9)
    assertEquals(testsetFocalPx, half.fy, 1e-9)
    assertEquals(640.0, half.cx, 1e-9)
    assertEquals(480.0, half.cy, 1e-9)
    // A square 1280 x 1280 reference read at 4:3: the middle 960 rows, no scale.
    val sq = CameraIntrinsics(testsetFocalPx, testsetFocalPx, 640.0, 640.0, FloatArray(0), FloatArray(0))
    val crop = scaleIntrinsics(sq, 1280, 1280, 1280, 960)
    assertEquals(testsetFocalPx, crop.fx, 1e-9)
    assertEquals(640.0, crop.cx, 1e-9)
    assertEquals(480.0, crop.cy, 1e-9)
    // Already at the stream size: unchanged.
    assertEquals(k, scaleIntrinsics(k, 1280, 960, 1280, 960))
  }

  // ── the circle's tilt picks the wall ──

  /**
   * A head at [eye] looking level (yaw only) at [centre], and the outline a 140 mm circle on a wall facing [normal]
   * (unit, into the room) has in its camera: the circle projected through the pinhole and fitted from its points'
   * second moments, as the detector reports it (major axis angle from +x toward +y, image y down).
   */
  private fun view(eye: Vec3, centre: Vec3, normal: Vec3): Pair<Pose, RingDetection> {
    val yaw = atan2(centre.x - eye.x, centre.z - eye.z)
    val head = Pose(eye.sdk(), Quaternion(cos(yaw / 2).toFloat(), 0f, sin(yaw / 2).toFloat(), 0f))
    val inv = Quat(cos(yaw / 2), 0.0, -sin(yaw / 2), 0.0)
    fun pixel(p: Vec3): Pair<Double, Double> {
      val h = inv.rotate(Vec3(p.x - eye.x, p.y - eye.y, p.z - eye.z))
      // head (y up) to camera (y down)
      return (k.fx * h.x / h.z + k.cx) to (k.fy * -h.y / h.z + k.cy)
    }
    // Two directions in the wall's plane.
    val u = Vec3(normal.z, 0.0, -normal.x)
    val v = Vec3(0.0, 1.0, 0.0)
    val pts = (0 until 360).map { i ->
      val t = Math.toRadians(i.toDouble())
      val r = ring140.diameter / 2
      pixel(Vec3(centre.x + r * (cos(t) * u.x + sin(t) * v.x), centre.y + r * (cos(t) * u.y + sin(t) * v.y), centre.z + r * (cos(t) * u.z + sin(t) * v.z)))
    }
    val mx = pts.sumOf { it.first } / pts.size
    val my = pts.sumOf { it.second } / pts.size
    val sxx = pts.sumOf { (it.first - mx) * (it.first - mx) } / pts.size
    val syy = pts.sumOf { (it.second - my) * (it.second - my) } / pts.size
    val sxy = pts.sumOf { (it.first - mx) * (it.second - my) } / pts.size
    val half = (sxx + syy) / 2
    val root = sqrt((sxx - syy) * (sxx - syy) / 4 + sxy * sxy)
    val angle = (Math.toDegrees(0.5 * atan2(2 * sxy, sxx - syy)) + 180.0) % 180.0
    val (cx, cy) = pixel(centre)
    return head to RingDetection(ring140.id, 0, 0, cx, cy, sqrt(2 * (half + root)), sqrt(2 * (half - root)), angle, 0.0)
  }

  /** [eye] [distance] m out from [centre] on a wall facing [normal], [offDeg] degrees round toward -x (level). */
  private fun eyeAt(centre: Vec3, normal: Vec3, distance: Double, offDeg: Double): Vec3 {
    val a = Math.toRadians(offDeg)
    // the normal turned about +y (toward -x for a -z wall)
    val dx = normal.x * cos(a) + normal.z * sin(a)
    val dz = -normal.x * sin(a) + normal.z * cos(a)
    return Vec3(centre.x + distance * dx, centre.y, centre.z + distance * dz)
  }

  private val wallA = Vec3(0.0, 0.0, -1.0) // the z = 3 wall, into the room
  private val wallB = Vec3(-1.0, 0.0, 0.0) // the x = 2 wall

  @Test
  fun tiltPicksTheWallTheMarkerIsOnAtACorner() {
    // 5 cm from the corner on wall A, seen from 1.2 m at 30°.
    val onA = Vec3(1.95, 1.5, 3.0)
    val eye = eyeAt(onA, wallA, 1.2, 30.0)
    val (head, d) = view(eye, onA, wallA)
    val tilt = circleNormals(d, k, head)
    assertEquals(2, tilt.size)
    // The measured position errs toward the camera, closer to wall B's plane (5 cm) than to A's (7 cm).
    val measured = Vector3(1.95f, 1.5f, 2.93f)
    // Nearest alone picks by the ray from the eye, which meets wall A first here (not the plane the point is nearer).
    assertEquals(180.0, wallHeading(measured, walls, eye.sdk(), null)!!, 1e-4)
    assertEquals(180.0, wallHeading(measured, walls, eye.sdk(), tilt)!!, 1e-4)
    assertEquals(180.0, wallHeading(onA.sdk(), walls, eye.sdk(), tilt)!!, 1e-4)
  }

  @Test
  fun tiltPicksWallBForAMarkerOnB() {
    val onB = Vec3(2.0, 1.5, 2.95)
    val eye = eyeAt(onB, wallB, 1.2, -30.0)
    val (head, d) = view(eye, onB, wallB)
    assertEquals(-90.0, wallHeading(Vector3(1.94f, 1.5f, 2.95f), walls, eye.sdk(), circleNormals(d, k, head))!!, 1e-4)
  }

  @Test
  fun tiltCandidatesIncludeTheTrueNormal() {
    val onA = Vec3(0.5, 1.5, 3.0)
    for (off in listOf(20.0, 30.0, 45.0, -40.0)) {
      val eye = eyeAt(onA, wallA, 1.2, off)
      val (head, d) = view(eye, onA, wallA)
      val best = circleNormals(d, k, head).minOf { c -> Math.toDegrees(acos((c.x * wallA.x + c.y * wallA.y + c.z * wallA.z).coerceIn(-1.0, 1.0))) }
      assertTrue("$off° off: $best° from the true normal", best < 5.0)
    }
  }

  @Test
  fun noWallAgreesWithTheTiltGivesNoHeading() {
    // The marker is on wall A, which the scan missed; only wall B is near. Seen at 20°, B is 50° off either tilt.
    val onA = Vec3(1.95, 1.5, 3.0)
    val eye = eyeAt(onA, wallA, 1.2, 20.0)
    val (head, d) = view(eye, onA, wallA)
    assertNull(wallHeading(onA.sdk(), listOf(walls[1]), eye.sdk(), circleNormals(d, k, head)))
  }

  @Test
  fun aRoundOutlineAcceptsOnlyAWallFacingTheCamera() {
    // Head-on: the outline is round, so the one candidate is the ray toward the camera.
    val onA = Vec3(1.95, 1.5, 3.0)
    val eye = eyeAt(onA, wallA, 1.2, 0.0)
    val (head, d) = view(eye, onA, wallA)
    assertTrue(d.semiMinor / d.semiMajor > ROUND_RATIO)
    val tilt = circleNormals(d, k, head)
    assertEquals(1, tilt.size)
    assertEquals(180.0, wallHeading(Vector3(1.95f, 1.5f, 2.93f), walls, eye.sdk(), tilt)!!, 1e-4)
    // Only the perpendicular wall near: 90° from the camera ray, so no heading.
    assertNull(wallHeading(onA.sdk(), listOf(walls[1]), eye.sdk(), tilt))
  }

  @Test
  fun aCornerSeenAt45DegreesIsAmbiguous() {
    // The false normal is 90° from wall A: on wall B. Both agree; which wins would be down to measurement error.
    val onA = Vec3(1.95, 1.5, 3.0)
    val eye = eyeAt(onA, wallA, 1.2, 45.0)
    val (head, d) = view(eye, onA, wallA)
    assertNull(wallHeading(onA.sdk(), walls, eye.sdk(), circleNormals(d, k, head)))
  }

  @Test
  fun aCornerSeenAt20Or60DegreesTakesTheMarkersWall() {
    val onA = Vec3(1.95, 1.5, 3.0)
    for (off in listOf(20.0, 60.0)) {
      val eye = eyeAt(onA, wallA, 1.2, off)
      val (head, d) = view(eye, onA, wallA)
      assertEquals("$off°", 180.0, wallHeading(onA.sdk(), walls, eye.sdk(), circleNormals(d, k, head))!!, 1e-4)
    }
  }

  @Test
  fun thePerpendicularWallAloneGivesNoHeading() {
    // The marker's own wall A is unscanned; wall B is 5 cm away. At 30° or 60° the false normal (at twice the view
    // angle from A's) is 30° from B, outside the tilt gate.
    val onA = Vec3(1.95, 1.5, 3.0)
    for (off in listOf(30.0, 60.0)) {
      val eye = eyeAt(onA, wallA, 1.2, off)
      val (head, d) = view(eye, onA, wallA)
      assertNull("$off°", wallHeading(onA.sdk(), listOf(walls[1]), eye.sdk(), circleNormals(d, k, head)))
    }
    // At 40-50° it agrees with B, but B is then 40-50° from head-on: too steep to count.
    for (off in listOf(40.0, 45.0, 50.0)) {
      val eye = eyeAt(onA, wallA, 1.2, off)
      val (head, d) = view(eye, onA, wallA)
      assertNull("$off°", lockedHeading(onA, listOf(walls[1]), eye, head, d))
    }
  }

  /** The heading a lock takes from one frame: the picked wall, unless the view is too steep (see `lockHeading`). */
  private fun lockedHeading(marker: Vec3, ws: List<WallPlane>, eye: Vec3, head: Pose, d: RingDetection): Double? =
      lockHeading(wallFix(marker.sdk(), ws, eye.sdk(), circleNormals(d, k, head)), circleTiltDeg(d)).headingDeg

  /** [d] with its outline's tilt reading [lowDeg] less than it should (blur squashes the major axis less). */
  private fun tiltReadsLow(d: RingDetection, lowDeg: Double): RingDetection =
      d.copy(semiMinor = d.semiMajor * cos(Math.toRadians(circleTiltDeg(d) - lowDeg)))

  @Test
  fun theMarkersOwnWallWithinHeadOnCounts() {
    val onA = Vec3(0.5, 1.5, 3.0)
    for (off in listOf(20.0, 28.0)) {
      val eye = eyeAt(onA, wallA, 1.2, off)
      val (head, d) = view(eye, onA, wallA)
      val fix = wallFix(onA.sdk(), walls, eye.sdk(), circleNormals(d, k, head))!!
      assertEquals("$off°", 180.0, fix.headingDeg!!, 1e-4)
      assertEquals("$off°", off, fix.viewAngleDeg, 0.5)
      assertEquals("$off°", off, circleTiltDeg(d), 1.0)
      assertEquals("$off°", 180.0, lockedHeading(onA, walls, eye, head, d)!!, 1e-4)
    }
  }

  @Test
  fun aTiltReadingLowStillNeverTakesALonePerpendicularWall() {
    // Wall A unscanned, wall B 5 cm away, the tilt reading 5° low: by B the view looks 32-35° from head-on, and the
    // tilt itself says 50-53°.
    val onA = Vec3(1.95, 1.5, 3.0)
    for (off in listOf(55.0, 56.0, 57.0, 58.0)) {
      val eye = eyeAt(onA, wallA, 1.2, off)
      val (head, d) = view(eye, onA, wallA)
      assertNull("$off°", lockedHeading(onA, listOf(walls[1]), eye, head, tiltReadsLow(d, 5.0)))
    }
  }

  @Test
  fun theTiltTermAloneKeepsALonePerpendicularWallOut() {
    // Wall A unscanned, wall B 5 cm away, seen at 60-62° with the tilt reading 10-15° low. Either the tilt gate drops B
    // outright, or B passes it and looks under 30° from head-on, so the wall check alone would take B: the circle's own
    // tilt (still over 30°) is what refuses it. Both ways there is no heading.
    val onA = Vec3(1.95, 1.5, 3.0)
    var passedTiltGate = 0
    for (off in listOf(60.0, 61.0, 62.0)) {
      for (low in listOf(10.0, 12.0, 15.0)) {
        val eye = eyeAt(onA, wallA, 1.2, off)
        val (head, d) = view(eye, onA, wallA)
        val read = tiltReadsLow(d, low)
        assertNull("$off° -$low°", lockedHeading(onA, listOf(walls[1]), eye, head, read))
        val fix = wallFix(onA.sdk(), listOf(walls[1]), eye.sdk(), circleNormals(read, k, head)) ?: continue
        passedTiltGate++
        assertTrue("$off° -$low°: B looks head-on enough", fix.headingDeg != null && fix.viewAngleDeg <= 30.0)
        assertTrue("$off° -$low°: the tilt is steep", circleTiltDeg(read) > 30.0)
        assertTrue("$off° -$low°: without the tilt term B would count", lockHeading(fix, 0.0).headingDeg != null)
      }
    }
    assertTrue("some case reaches the tilt term", passedTiltGate > 0)
  }

  @Test
  fun aMisprintedRingStillGetsItsWallsHeading() {
    // The ring's size puts it r / s along the ray for a print scaled by s: 13 cm behind the wall at 1.5 m for 92%, and
    // in front of it for a larger print. The wall is chosen by the ray, which doesn't depend on the print's scale.
    val onA = Vec3(0.5, 1.5, 3.0)
    for (off in listOf(0.0, 20.0)) {
      val eye = eyeAt(onA, wallA, 1.5, off)
      val (head, d) = view(eye, onA, wallA)
      for (scale in listOf(0.92, 1.05)) {
        val measured = Vec3(eye.x + (onA.x - eye.x) / scale, eye.y + (onA.y - eye.y) / scale, eye.z + (onA.z - eye.z) / scale)
        val fix = wallFix(measured.sdk(), walls, eye.sdk(), circleNormals(d, k, head))!!
        assertEquals("$off° x$scale", 180.0, fix.headingDeg!!, 1e-4)
      }
    }
  }

  @Test
  fun aTiltReadingLowStillTakesTheMarkersOwnWall() {
    val onA = Vec3(1.95, 1.5, 3.0)
    for (off in listOf(20.0, 28.0)) {
      val eye = eyeAt(onA, wallA, 1.2, off)
      val (head, d) = view(eye, onA, wallA)
      assertEquals("$off°", 180.0, lockedHeading(onA, walls, eye, head, tiltReadsLow(d, 5.0))!!, 1e-4)
    }
  }

  @Test
  fun anAmbiguousCornerSeenSteeplyIsTooSteep() {
    // No heading at 45° from the corner, and the view says why: stand in front.
    val onA = Vec3(1.95, 1.5, 3.0)
    val eye = eyeAt(onA, wallA, 1.2, 45.0)
    val (head, d) = view(eye, onA, wallA)
    val fix = wallFix(onA.sdk(), walls, eye.sdk(), circleNormals(d, k, head))!!
    assertNull(fix.headingDeg)
    assertTrue(lockHeading(fix, circleTiltDeg(d)).steep)
  }

  @Test
  fun aDetectedObliqueRingHasItsTrueNormalAmongTheCandidates() {
    // The test set turns the plaque about the vertical by angle_deg, its +x edge away from the camera: in camera space
    // (y down) the normal toward the camera is (sin a, 0, -cos a), and with no head or lens pose world space has the
    // same x and z.
    val dir = File("../../ring-marker/testset")
    val entries = Json.parseToJsonElement(File(dir, "manifest.json").readText()).jsonArray.map { it.jsonObject }
    for (name in listOf("range-RING140-1.2-30", "range-RING140-1.2-45")) {
      val e = entries.single { it["name"]!!.jsonPrimitive.content == name }
      val a = Math.toRadians(e["markers"]!!.jsonArray.single().jsonObject["angle_deg"]!!.jsonPrimitive.double)
      val truth = Vec3(sin(a), 0.0, -cos(a))
      val img = loadTestsetImage(File(dir, e["file"]!!.jsonPrimitive.content))
      val d = RingDetector().detectFrame(img.gray, img.width, img.height).detections.single()
      val tilt = circleNormals(d, k, Pose())
      assertEquals(name, 2, tilt.size)
      val best = tilt.minOf { c -> Math.toDegrees(acos((c.x * truth.x + c.y * truth.y + c.z * truth.z).coerceIn(-1.0, 1.0))) }
      assertTrue("$name: $best° from the true normal", best < 5.0)
    }
  }
}
