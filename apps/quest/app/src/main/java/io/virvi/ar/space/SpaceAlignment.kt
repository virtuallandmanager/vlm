package io.virvi.ar.space

import io.virvi.ar.Quat
import io.virvi.ar.Vec3
import io.virvi.ar.api.MarkerPose

/** The scene's origin in world space and its turn about +Y. A scene point `s` lands at `position + R_y(yawDeg)·s`. */
data class RootPose(val position: Vec3, val yawDeg: Double)

internal fun rotateY(deg: Double, v: Vec3) = Quat.axisAngle(0.0, 1.0, 0.0, Math.toRadians(deg)).rotate(v)

/**
 * Where the scene root must sit so that a marker saved at `saved` (scene coordinates) is at `markerWorld` facing
 * `headingWorldDeg`. Headings are degrees from +Z toward +X, as in `wallHeading`. The scene stays level.
 */
fun rootFromMarker(markerWorld: Vec3, headingWorldDeg: Double, saved: MarkerPose): RootPose {
  val yaw = headingWorldDeg - saved.headingDeg
  val r = rotateY(yaw, Vec3(saved.x, saved.y, saved.z))
  return RootPose(Vec3(markerWorld.x - r.x, markerWorld.y - r.y, markerWorld.z - r.z), yaw)
}

/** The inverse of [rootFromMarker]: where a marker seen in the world sits in scene coordinates. */
fun markerInScene(root: RootPose, markerWorld: Vec3, headingWorldDeg: Double): MarkerPose {
  val d = Vec3(markerWorld.x - root.position.x, markerWorld.y - root.position.y, markerWorld.z - root.position.z)
  val s = rotateY(-root.yawDeg, d)
  val heading = ((headingWorldDeg - root.yawDeg) % 360.0 + 360.0) % 360.0
  return MarkerPose(s.x, s.y, s.z, heading)
}

/** Shortest signed difference `a − b` in degrees, in (−180, 180]. */
fun angleDiffDeg(a: Double, b: Double): Double {
  val d = ((a - b) % 360.0 + 360.0) % 360.0
  return if (d > 180.0) d - 360.0 else d
}
