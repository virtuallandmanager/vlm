package gg.vlm.spaces.ring

import com.meta.spatial.core.Pose
import com.meta.spatial.core.Vector3
import gg.vlm.spaces.Quat
import gg.vlm.spaces.Vec3
import kotlin.math.abs
import kotlin.math.acos
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Where a detected ring marker is, in camera space (metres; +x right, +y down, +z forward, as in the image).
 *
 * The distance comes from the finder ring's size: its outer edge is the printed diameter [diameterM], and its fitted
 * semi-major axis barely shrinks when the marker is tilted (tilt squashes the minor axis), so the range along the ray is
 * `fx * (diameterM / 2) / semiMajor`. The direction is the ray through the ellipse centre. [k] must be the intrinsics
 * at the detector's image size (see [scaleIntrinsics]). The perspective shift of the centre dot against the ellipse's
 * centre is ignored: both are the dot's centre in the detector's output.
 */
fun markerInCamera(d: RingDetection, k: CameraIntrinsics, diameterM: Double): Vec3 {
  val range = k.fx * (diameterM / 2) / d.semiMajor
  val rx = (d.cx - k.cx) / k.fx
  val ry = (d.cy - k.cy) / k.fy
  val n = sqrt(rx * rx + ry * ry + 1)
  return Vec3(rx / n * range, ry / n * range, range / n)
}

/**
 * Camera space (as [markerInCamera] gives it) to Spatial SDK world space: the lens pose relative to the head, then the
 * [head] pose.
 *
 * The lens pose is read as Android defines `LENS_POSE_*`: `LENS_POSE_ROTATION` (x, y, z, w) rotates the Android sensor
 * frame (x right, y up, z out of the device toward the wearer; right-handed) into the camera frame (x right, y down,
 * z along the optical axis), and `LENS_POSE_TRANSLATION` is the optical centre in metres in that sensor frame, relative
 * to `LENS_POSE_REFERENCE`. So a sensor-frame point is `R⁻¹ p + t`, and Spatial SDK's head frame (left-handed, +z
 * forward) is the sensor frame with z negated. A camera looking straight ahead reports a rotation of about 180° about x.
 *
 * **Unconfirmed on Quest:** that the reference is the head pose Spatial SDK reports (`scene.getViewerPose()`), and that
 * Meta follows the Android rotation direction rather than its inverse. PassthroughCamera logs the raw pose and
 * reference once; the headset check (marker distance against a tape measure, and the marker landing on its wall)
 * confirms or corrects this. Without a lens pose the camera is taken to sit at the head, looking forward.
 */
fun cameraToWorld(p: Vec3, head: Pose, k: CameraIntrinsics): Vector3 {
  val r = k.lensRotation
  val lens = if (r.size >= 4) normalised(Quat(r[3].toDouble(), r[0].toDouble(), r[1].toDouble(), r[2].toDouble())) else LOOKING_AHEAD
  val t = k.lensTranslation
  val s = Quat(lens.w, -lens.x, -lens.y, -lens.z).rotate(p)
  val sensor = if (t.size >= 3) Vec3(s.x + t[0], s.y + t[1], s.z + t[2]) else s
  return head.times(Vector3(sensor.x.toFloat(), sensor.y.toFloat(), (-sensor.z).toFloat()))
}

/** A wall from the room scan: its centre and unit normal in world space, and its half extents along and up the wall. */
data class WallPlane(val centre: Vector3, val normal: Vector3, val halfWidth: Float, val halfHeight: Float)

/**
 * The heading, in degrees from world +z toward +x in (-180, 180], of the wall the marker is on: the normal of a wall
 * within [WALL_TOLERANCE_M] of [marker] (and within its edges, give or take the same), turned to point toward
 * [viewer]'s side of the wall, into the room. Walls are taken as vertical, as MRUK reports them.
 *
 * [tilt] (the circle's own tilt, from [circleNormals]) checks that the marker is on that wall: a wall counts only if its
 * into-room normal is within [TILT_TOLERANCE_DEG] of one of the tilt's normals, and of the walls that count the one
 * that agrees best wins (near an inside corner or a door frame the perpendicular wall is just as close). The tilt's
 * false normal sits at twice the view angle from the true one, so seen at about 45° from an inside corner it lands on
 * the perpendicular wall: when a wall facing another way agrees within [TILT_AMBIGUOUS_DEG] of the best, the pick
 * would be decided by measurement error, so there is no heading (the visitor is asked to look around and moves).
 * Null when no wall is close, none agrees with the tilt, or two walls agree about as well. A null [tilt] skips the
 * check and takes the nearest wall (the developer panel, which has no single frame's outline). See [wallFix] for the
 * view angle too.
 */
fun wallHeading(marker: Vector3, walls: List<WallPlane>, viewer: Vector3, tilt: List<Vec3>?): Double? =
    wallFix(marker, walls, viewer, tilt)?.headingDeg

/**
 * The marker's wall as [wallHeading] picks it: its [headingDeg] (null when another wall agrees with the tilt about as
 * well), and [viewAngleDeg], the level angle between the best wall's into-room normal and the ray from the marker
 * toward the viewer (0 head-on).
 */
data class WallFix(val headingDeg: Double?, val viewAngleDeg: Double)

/** [wallHeading], with the view angle of the wall it picks (see [WallFix]). */
fun wallFix(marker: Vector3, walls: List<WallPlane>, viewer: Vector3, tilt: List<Vec3>?): WallFix? {
  // Each wall that counts: its into-room normal and its score (lower is better).
  val passing = ArrayList<Pair<Vec3, Double>>()
  for (w in walls) {
    val n = flatUnit(w.normal) ?: continue
    val dx = (marker.x - w.centre.x).toDouble()
    val dy = (marker.y - w.centre.y).toDouble()
    val dz = (marker.z - w.centre.z).toDouble()
    val gap = abs(dx * n.x + dz * n.z)
    val along = abs(dx * n.z - dz * n.x)
    if (gap > WALL_TOLERANCE_M || along > w.halfWidth + WALL_TOLERANCE_M || abs(dy) > w.halfHeight + WALL_TOLERANCE_M) continue
    val side = (viewer.x - w.centre.x) * n.x + (viewer.z - w.centre.z) * n.z
    val inward = if (side < 0) Vec3(-n.x, 0.0, -n.z) else n
    val score =
        if (tilt == null) gap
        else tilt.minOf { angleDeg(inward, it) }.takeIf { it <= TILT_TOLERANCE_DEG } ?: continue
    passing += inward to score
  }
  val (n, bestScore) = passing.minByOrNull { it.second } ?: return null
  val toViewer = flatUnit(Vector3(viewer.x - marker.x, 0f, viewer.z - marker.z))
  val view = toViewer?.let { angleDeg(n, it) } ?: 0.0
  val ambiguous =
      tilt != null &&
          passing.any { (m, score) -> angleDeg(m, n) > TILT_AMBIGUOUS_DEG && score - bestScore < TILT_AMBIGUOUS_DEG }
  if (ambiguous) return WallFix(null, view)
  val deg = Math.toDegrees(atan2(n.x, n.z))
  return WallFix(if (deg <= -180.0) deg + 360.0 else deg, view) // (-180, 180]; a -0.0 x would give -180
}

/**
 * The plane normals (world space, unit, toward the camera) a printed circle with [d]'s outline could have. A tilted
 * circle's outline is squashed along its minor axis by the cosine of the tilt, so the normal leans from the ray toward
 * the camera by `acos(minor / major)`, one way or the other along the minor axis: two candidates. A nearly round
 * outline (minor / major above [ROUND_RATIO]) can't tell which way it leans, so the one candidate is the ray toward
 * the camera. This treats the outline as seen along its own ray (no perspective skew), which is well within the
 * [TILT_TOLERANCE_DEG] it is checked to.
 */
fun circleNormals(d: RingDetection, k: CameraIntrinsics, head: Pose): List<Vec3> {
  val ray = unit(Vec3((d.cx - k.cx) / k.fx, (d.cy - k.cy) / k.fy, 1.0))
  val toCamera = Vec3(-ray.x, -ray.y, -ray.z)
  val ratio = if (d.semiMajor > 0) d.semiMinor / d.semiMajor else 1.0
  val inCamera =
      if (ratio > ROUND_RATIO) listOf(toCamera)
      else {
        val th = Math.toRadians(d.angleDeg)
        // The minor axis, lifted from the image to camera space at the ellipse's centre, square to the ray.
        val u = Vec3(-sin(th) / k.fx, cos(th) / k.fy, 0.0)
        val along = u.x * ray.x + u.y * ray.y + u.z * ray.z
        val m = unit(Vec3(u.x - along * ray.x, u.y - along * ray.y, u.z - along * ray.z))
        val tau = acos(ratio.coerceIn(0.0, 1.0))
        val c = cos(tau)
        val s = sin(tau)
        listOf(
            Vec3(toCamera.x * c + m.x * s, toCamera.y * c + m.y * s, toCamera.z * c + m.z * s),
            Vec3(toCamera.x * c - m.x * s, toCamera.y * c - m.y * s, toCamera.z * c - m.z * s),
        )
      }
  val origin = cameraToWorld(Vec3(0.0, 0.0, 0.0), head, k)
  return inCamera.map { v ->
    val w = cameraToWorld(v, head, k)
    unit(Vec3((w.x - origin.x).toDouble(), (w.y - origin.y).toDouble(), (w.z - origin.z).toDouble()))
  }
}

/** How far [d]'s circle is tilted from facing the camera, from its outline alone: `acos(minor / major)`, in degrees. */
fun circleTiltDeg(d: RingDetection): Double =
    Math.toDegrees(acos((if (d.semiMajor > 0) d.semiMinor / d.semiMajor else 1.0).coerceIn(0.0, 1.0)))

/**
 * [k] (calibrated against a [refWidth] × [refHeight] reference, the sensor's pre-correction active array) at a
 * [width] × [height] stream. As in Meta's passthrough camera samples, the stream is taken to be the reference
 * centre-cropped to the stream's aspect ratio, then scaled. The lens pose is unchanged.
 */
fun scaleIntrinsics(k: CameraIntrinsics, refWidth: Int, refHeight: Int, width: Int, height: Int): CameraIntrinsics {
  val sx = width.toDouble() / refWidth
  val sy = height.toDouble() / refHeight
  val m = max(sx, sy)
  // The cropped reference region, in reference pixels.
  val cropW = refWidth * sx / m
  val cropH = refHeight * sy / m
  val cropX = (refWidth - cropW) / 2
  val cropY = (refHeight - cropH) / 2
  val s = width / cropW
  return k.copy(fx = k.fx * s, fy = k.fy * s, cx = (k.cx - cropX) * s, cy = (k.cy - cropY) * s)
}

/** How far a marker may sit from a wall's plane (and past its edges) and still count as on it. */
const val WALL_TOLERANCE_M = 0.10

/** How far a wall's normal may be from the circle's tilt (see [circleNormals]) and still count as the marker's wall. */
const val TILT_TOLERANCE_DEG = 20.0

/**
 * Two walls facing ways more than this apart that both agree with the tilt, the runner-up by less than this more than
 * the best, leave the marker's wall in doubt (see [wallHeading]).
 */
const val TILT_AMBIGUOUS_DEG = 15.0

/** An outline rounder than this (minor / major) says nothing about which way the circle is tilted. */
const val ROUND_RATIO = 0.97

/** The camera frame of a lens looking straight ahead from the head: 180° about x (y down, z forward). */
private val LOOKING_AHEAD = Quat(0.0, 1.0, 0.0, 0.0)

private fun normalised(q: Quat): Quat {
  val n = sqrt(q.w * q.w + q.x * q.x + q.y * q.y + q.z * q.z)
  return if (n < 1e-9) LOOKING_AHEAD else Quat(q.w / n, q.x / n, q.y / n, q.z / n)
}

private fun unit(v: Vec3): Vec3 {
  val n = sqrt(v.x * v.x + v.y * v.y + v.z * v.z)
  return Vec3(v.x / n, v.y / n, v.z / n)
}

/** The angle between unit vectors [a] and [b], in degrees. */
private fun angleDeg(a: Vec3, b: Vec3): Double =
    Math.toDegrees(acos((a.x * b.x + a.y * b.y + a.z * b.z).coerceIn(-1.0, 1.0)))

private fun flatUnit(v: Vector3): Vec3? {
  val len = sqrt((v.x * v.x + v.z * v.z).toDouble())
  return if (len < 1e-3) null else Vec3(v.x / len, 0.0, v.z / len)
}

/**
 * The last [capacity] world positions of one marker, averaged before the scene snaps to it: one sample carries head
 * pose noise and lag, the mean of several far less. [ready] once there are at least [minCount]. Clear it when the
 * marker is lost, so a mean always comes from the current sighting. Not thread-safe (main thread only).
 */
class PoseAverager(private val capacity: Int = 15, private val minCount: Int = 5) {
  private val samples = ArrayDeque<Vec3>()

  val count: Int
    get() = samples.size

  val ready: Boolean
    get() = samples.size >= minCount

  fun add(p: Vec3) {
    if (samples.size == capacity) samples.removeFirst()
    samples.addLast(p)
  }

  fun clear() {
    samples.clear()
  }

  /** The mean position, or null with no samples. */
  fun mean(): Vec3? {
    if (samples.isEmpty()) return null
    val n = samples.size.toDouble()
    return Vec3(samples.sumOf { it.x } / n, samples.sumOf { it.y } / n, samples.sumOf { it.z } / n)
  }

  /** The largest distance of a sample from the [mean], in metres, or null with no samples. */
  fun spread(): Double? {
    val m = mean() ?: return null
    return samples.maxOf { sqrt((it.x - m.x) * (it.x - m.x) + (it.y - m.y) * (it.y - m.y) + (it.z - m.z) * (it.z - m.z)) }
  }
}
