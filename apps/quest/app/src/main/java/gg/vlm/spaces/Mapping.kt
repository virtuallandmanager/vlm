package gg.vlm.spaces

import kotlin.math.cos
import kotlin.math.sin

/**
 * VLM (Decentraland: left-handed, Y up, +Z forward, metres) to Spatial SDK, which uses the same frame. So unlike the
 * RealityKit and three.js ports, nothing is mirrored: positions and scales carry over as they are, and rotations are
 * Decentraland's Euler degrees applied in its yaw-pitch-roll order (three.js 'YXZ': q = qY * qX * qZ).
 */
data class Vec3(val x: Double, val y: Double, val z: Double)

/** w, x, y, z; same layout as com.meta.spatial.core.Quaternion. */
data class Quat(val w: Double, val x: Double, val y: Double, val z: Double) {
  operator fun times(o: Quat) =
      Quat(
          w * o.w - x * o.x - y * o.y - z * o.z,
          w * o.x + x * o.w + y * o.z - z * o.y,
          w * o.y - x * o.z + y * o.w + z * o.x,
          w * o.z + x * o.y - y * o.x + z * o.w,
      )

  /** Rotates `v` (q v q*). */
  fun rotate(v: Vec3): Vec3 {
    val r = this * Quat(0.0, v.x, v.y, v.z) * Quat(w, -x, -y, -z)
    return Vec3(r.x, r.y, r.z)
  }

  companion object {
    val IDENTITY = Quat(1.0, 0.0, 0.0, 0.0)

    fun axisAngle(ax: Double, ay: Double, az: Double, radians: Double): Quat {
      val s = sin(radians / 2)
      return Quat(cos(radians / 2), ax * s, ay * s, az * s)
    }

    /** Euler degrees applied in YXZ order. */
    fun yxzDegrees(r: Vec3): Quat {
      val d = Math.PI / 180
      return axisAngle(0.0, 1.0, 0.0, r.y * d) * axisAngle(1.0, 0.0, 0.0, r.x * d) * axisAngle(0.0, 0.0, 1.0, r.z * d)
    }
  }
}

data class MappedTransform(val position: Vec3, val rotation: Quat, val scale: Vec3)

fun toSpatialTransform(position: Vec3, rotation: Vec3, scale: Vec3) =
    MappedTransform(position, Quat.yxzDegrees(rotation), scale)

/** Where the scene's middle sits in VLM coordinates: the centre of a single 16 m parcel, at ground level. */
val VLM_SCENE_CENTER = Vec3(8.0, 0.0, 8.0)
