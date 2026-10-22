package gg.vlm.spaces.quest.ring

import com.meta.spatial.core.Pose
import com.meta.spatial.core.Vector3
import gg.vlm.spaces.quest.Quat
import gg.vlm.spaces.quest.Vec3
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.max
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
 * The heading, in degrees from world +z toward +x in (-180, 180], of the wall the marker is on: the normal of the nearest wall within
 * [WALL_TOLERANCE_M] of [marker] (and within its edges, give or take the same), turned to point toward [viewer]'s side
 * of the wall, into the room. Null when no wall is that close. Walls are taken as vertical, as MRUK reports them.
 */
fun wallHeading(marker: Vector3, walls: List<WallPlane>, viewer: Vector3): Double? {
  var best: WallPlane? = null
  var bestGap = Double.MAX_VALUE
  for (w in walls) {
    val n = flatUnit(w.normal) ?: continue
    val dx = (marker.x - w.centre.x).toDouble()
    val dy = (marker.y - w.centre.y).toDouble()
    val dz = (marker.z - w.centre.z).toDouble()
    val gap = abs(dx * n.x + dz * n.z)
    val along = abs(dx * n.z - dz * n.x)
    if (gap > WALL_TOLERANCE_M || along > w.halfWidth + WALL_TOLERANCE_M || abs(dy) > w.halfHeight + WALL_TOLERANCE_M) continue
    if (gap < bestGap) {
      bestGap = gap
      best = w
    }
  }
  val w = best ?: return null
  val n = flatUnit(w.normal)!!
  val side = (viewer.x - w.centre.x) * n.x + (viewer.z - w.centre.z) * n.z
  val sign = if (side < 0) -1.0 else 1.0
  val deg = Math.toDegrees(atan2(sign * n.x, sign * n.z))
  return if (deg <= -180.0) deg + 360.0 else deg // (-180, 180]; a -0.0 x would give -180
}

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

/** The camera frame of a lens looking straight ahead from the head: 180° about x (y down, z forward). */
private val LOOKING_AHEAD = Quat(0.0, 1.0, 0.0, 0.0)

private fun normalised(q: Quat): Quat {
  val n = sqrt(q.w * q.w + q.x * q.x + q.y * q.y + q.z * q.z)
  return if (n < 1e-9) LOOKING_AHEAD else Quat(q.w / n, q.x / n, q.y / n, q.z / n)
}

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
