package gg.vlm.spaces.builder

import gg.vlm.spaces.Quat
import gg.vlm.spaces.Vec3
import kotlin.math.abs
import kotlin.math.asin
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.sin
import kotlin.math.sqrt

enum class Axis {
  X,
  Y,
  Z;

  val unit: Vec3
    get() =
        when (this) {
          X -> Vec3(1.0, 0.0, 0.0)
          Y -> Vec3(0.0, 1.0, 0.0)
          Z -> Vec3(0.0, 0.0, 1.0)
        }
}

operator fun Vec3.get(axis: Axis): Double =
    when (axis) {
      Axis.X -> x
      Axis.Y -> y
      Axis.Z -> z
    }

/** This vector with its [axis] component set to [value]. */
fun Vec3.with(axis: Axis, value: Double): Vec3 =
    when (axis) {
      Axis.X -> copy(x = value)
      Axis.Y -> copy(y = value)
      Axis.Z -> copy(z = value)
    }

/** [direction] is expected to be normalized. */
data class Ray(val origin: Vec3, val direction: Vec3)

/**
 * Port of packages/vlm-core/src/transform/math.ts: vector and quaternion math for in-world editing, in the
 * Decentraland convention (left-handed, Euler degrees applied yaw(Y) / pitch(X) / roll(Z) like
 * `Quaternion.fromEulerDegrees`). Spatial SDK shares that frame (see Mapping.kt), so scene coordinates go in unchanged.
 */
object TransformMath {
  private const val DEG2RAD = Math.PI / 180
  private const val RAD2DEG = 180 / Math.PI
  private const val EPSILON = 1e-6

  fun add(a: Vec3, b: Vec3) = Vec3(a.x + b.x, a.y + b.y, a.z + b.z)

  fun sub(a: Vec3, b: Vec3) = Vec3(a.x - b.x, a.y - b.y, a.z - b.z)

  fun scale(v: Vec3, s: Double) = Vec3(v.x * s, v.y * s, v.z * s)

  fun dot(a: Vec3, b: Vec3) = a.x * b.x + a.y * b.y + a.z * b.z

  fun cross(a: Vec3, b: Vec3) = Vec3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x)

  fun length(v: Vec3) = sqrt(dot(v, v))

  fun normalize(v: Vec3): Vec3 {
    val len = length(v)
    return if (len == 0.0) Vec3(0.0, 0.0, 0.0) else scale(v, 1 / len)
  }

  /** Same result as DCL `Quaternion.fromEulerDegrees(x, y, z)`. */
  fun eulerDegreesToQuat(e: Vec3): Quat {
    val hp = e.x * DEG2RAD * 0.5
    val hy = e.y * DEG2RAD * 0.5
    val hr = e.z * DEG2RAD * 0.5
    val c1 = cos(hp)
    val s1 = sin(hp)
    val c2 = cos(hy)
    val s2 = sin(hy)
    val c3 = cos(hr)
    val s3 = sin(hr)
    return Quat(
        w = c2 * c1 * c3 + s2 * s1 * s3,
        x = c2 * s1 * c3 + s2 * c1 * s3,
        y = s2 * c1 * c3 - c2 * s1 * s3,
        z = c2 * c1 * s3 - s2 * s1 * c3,
    )
  }

  private fun repeat360(deg: Double) = deg - floor(deg / 360) * 360

  /** Same result as DCL `Quaternion.toEulerAngles(q)`, in degrees, each component in [0, 360). */
  fun quatToEulerDegrees(q: Quat): Vec3 {
    val unit = q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w
    val test = q.x * q.w - q.y * q.z
    val x: Double
    val y: Double
    val z: Double
    if (test > 0.4995 * unit) {
      x = Math.PI / 2
      y = 2 * atan2(q.y, q.x)
      z = 0.0
    } else if (test < -0.4995 * unit) {
      x = -Math.PI / 2
      y = -2 * atan2(q.y, q.x)
      z = 0.0
    } else {
      x = asin(2 * (q.w * q.x - q.y * q.z))
      y = atan2(2 * q.w * q.y + 2 * q.z * q.x, 1 - 2 * (q.x * q.x + q.y * q.y))
      z = atan2(2 * q.w * q.z + 2 * q.x * q.y, 1 - 2 * (q.z * q.z + q.x * q.x))
    }
    return Vec3(repeat360(x * RAD2DEG), repeat360(y * RAD2DEG), repeat360(z * RAD2DEG))
  }

  /** Hamilton product: the rotation that applies [b] first, then [a]. */
  fun quatMultiply(a: Quat, b: Quat): Quat = a * b

  fun quatFromAxisAngle(axis: Vec3, degrees: Double): Quat {
    val n = normalize(axis)
    val half = degrees * DEG2RAD * 0.5
    val s = sin(half)
    return Quat(cos(half), n.x * s, n.y * s, n.z * s)
  }

  /** [v] turned by [q] (q·v·q⁻¹, same as DCL `Vector3.rotate(v, q)`); [q] is expected to be unit length. */
  fun rotateVector(q: Quat, v: Vec3): Vec3 {
    val u = Vec3(q.x, q.y, q.z)
    val t = scale(cross(u, v), 2.0)
    return add(add(v, scale(t, q.w)), cross(u, t))
  }

  /** Where the ray meets the plane, or null if parallel or the hit is behind the origin. */
  fun rayPlane(ray: Ray, planePoint: Vec3, planeNormal: Vec3): Vec3? {
    val denom = dot(ray.direction, planeNormal)
    if (abs(denom) < EPSILON) return null
    val t = dot(sub(planePoint, ray.origin), planeNormal) / denom
    if (t < 0) return null
    return add(ray.origin, scale(ray.direction, t))
  }

  /** The point on the axis line (through [axisPoint]) nearest the ray, or null if the ray is parallel to it. */
  fun closestPointOnAxis(ray: Ray, axisPoint: Vec3, axis: Vec3): Vec3? {
    val u = normalize(axis)
    val w0 = sub(ray.origin, axisPoint)
    val b = dot(ray.direction, u)
    val denom = 1 - b * b // ray.direction and u are unit length
    if (denom < EPSILON) return null
    val d = dot(ray.direction, w0)
    val e = dot(u, w0)
    return add(axisPoint, scale(u, (e - b * d) / denom))
  }

  /**
   * Signed angle (degrees, -180..180) of where the ray hits the ring plane around [axis], measured from a fixed
   * reference direction (x: +y, y: +z, z: +x) toward `axis x reference`. Null if the ray misses the plane.
   */
  fun angleOnRing(ray: Ray, center: Vec3, axis: Vec3): Double? {
    val n = normalize(axis)
    val hit = rayPlane(ray, center, n) ?: return null
    val dominant =
        if (abs(n.x) >= abs(n.y) && abs(n.x) >= abs(n.z)) Axis.X else if (abs(n.y) >= abs(n.z)) Axis.Y else Axis.Z
    val next =
        when (dominant) {
          Axis.X -> Axis.Y
          Axis.Y -> Axis.Z
          Axis.Z -> Axis.X
        }.unit
    val ref = normalize(sub(next, scale(n, dot(next, n))))
    val quarter = cross(n, ref)
    val v = sub(hit, center)
    return atan2(dot(v, quarter), dot(v, ref)) * RAD2DEG
  }

  /** Rounds half up, like JS `Math.round`. */
  fun snap(value: Double, step: Double): Double = jsRound(value / step) * step

  /** JS `Math.round`: halves go up (-2.5 → -2), unlike Kotlin's round-half-even. */
  fun jsRound(v: Double): Double = floor(v + 0.5)

  /** Wraps a degree difference into -180..180. */
  fun wrap180(deg: Double): Double = deg - jsRound(deg / 360) * 360

  private const val CLOSE = 1e-4

  private fun closeTo(a: Double, b: Double) = abs(a - b) < CLOSE

  /** Degrees compared modulo 360, so 359.99999 and 0 are the same angle. */
  private fun closeAngle(a: Double, b: Double) = closeTo(wrap180(a - b), 0.0)

  fun sameVec(a: Vec3, b: Vec3) = closeTo(a.x, b.x) && closeTo(a.y, b.y) && closeTo(a.z, b.z)

  fun sameRotation(a: Vec3, b: Vec3) = closeAngle(a.x, b.x) && closeAngle(a.y, b.y) && closeAngle(a.z, b.z)

  /** Equal within 1e-4, rotations modulo 360 (session.ts `sameTransform`). */
  fun sameTransform(a: ItemTransform, b: ItemTransform) =
      sameVec(a.position, b.position) && sameRotation(a.rotation, b.rotation) && sameVec(a.scale, b.scale)
}
