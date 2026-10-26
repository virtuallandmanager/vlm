package gg.vlm.spaces.builder

import gg.vlm.spaces.Quat
import gg.vlm.spaces.Vec3
import gg.vlm.spaces.builder.TransformMath.angleOnRing
import gg.vlm.spaces.builder.TransformMath.closestPointOnAxis
import gg.vlm.spaces.builder.TransformMath.eulerDegreesToQuat
import gg.vlm.spaces.builder.TransformMath.normalize
import gg.vlm.spaces.builder.TransformMath.quatFromAxisAngle
import gg.vlm.spaces.builder.TransformMath.quatMultiply
import gg.vlm.spaces.builder.TransformMath.quatToEulerDegrees
import gg.vlm.spaces.builder.TransformMath.rayPlane
import gg.vlm.spaces.builder.TransformMath.rotateVector
import gg.vlm.spaces.builder.TransformMath.snap
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Port of packages/core/test/transform-math.test.ts, case for case. */
class TransformMathTest {
  private fun v(x: Double, y: Double, z: Double) = Vec3(x, y, z)

  private class DclVector(val e: DoubleArray, val q: DoubleArray, val back: DoubleArray)

  // Generated once from the DCL math (@dcl/ecs-math 2.1.0) with Quaternion.fromEulerDegrees(e) and
  // Quaternion.toEulerAngles(q); q is x, y, z, w.
  private val dclVectors =
      listOf(
          DclVector(doubleArrayOf(0.0, 0.0, 0.0), doubleArrayOf(0.0, 0.0, 0.0, 1.0), doubleArrayOf(0.0, 0.0, 0.0)),
          DclVector(
              doubleArrayOf(0.0, 90.0, 0.0),
              doubleArrayOf(0.0, 0.7071067811865475, 0.0, 0.7071067811865476),
              doubleArrayOf(0.0, 89.99999999999999, 0.0),
          ),
          DclVector(
              doubleArrayOf(90.0, 0.0, 0.0),
              doubleArrayOf(0.7071067811865475, 0.0, 0.0, 0.7071067811865476),
              doubleArrayOf(90.0, 0.0, 0.0),
          ),
          DclVector(
              doubleArrayOf(0.0, 0.0, 90.0),
              doubleArrayOf(0.0, 0.0, 0.7071067811865475, 0.7071067811865476),
              doubleArrayOf(0.0, 0.0, 89.99999999999999),
          ),
          DclVector(
              doubleArrayOf(30.0, 45.0, 60.0),
              doubleArrayOf(0.3919038373291199, 0.20056212114657512, 0.3604234056503559, 0.8223631719059994),
              doubleArrayOf(29.999999999999993, 45.0, 59.99999999999999),
          ),
          DclVector(
              doubleArrayOf(90.0, 30.0, 0.0),
              doubleArrayOf(0.6830127018922193, 0.18301270189221933, -0.1830127018922193, 0.6830127018922194),
              doubleArrayOf(90.0, 29.999999999999996, 0.0),
          ),
          DclVector(
              doubleArrayOf(135.0, 20.0, 10.0),
              doubleArrayOf(0.9121731942755071, -0.013098696101331922, -0.12697316175171494, 0.38941790405737065),
              doubleArrayOf(45.00000000000001, 200.0, 190.0),
          ),
          DclVector(
              doubleArrayOf(-45.0, 200.0, 15.0),
              doubleArrayOf(0.18464220931146905, 0.8933861241002776, 0.35270512272218274, -0.2082488516443552),
              doubleArrayOf(315.0, 200.0, 14.999999999999993),
          ),
      )

  private fun near(a: Double, b: Double, eps: Double = 1e-5) = assertTrue("$a vs $b", Math.abs(a - b) < eps)

  /** Same rotation: q and -q are equal. [b] is x, y, z, w. */
  private fun sameQuat(a: Quat, b: DoubleArray) {
    val d = a.x * b[0] + a.y * b[1] + a.z * b[2] + a.w * b[3]
    val s = if (d < 0) -1.0 else 1.0
    near(a.x, s * b[0])
    near(a.y, s * b[1])
    near(a.z, s * b[2])
    near(a.w, s * b[3])
  }

  private fun vecOf(a: DoubleArray) = v(a[0], a[1], a[2])

  // ── euler <-> quaternion (DCL convention) ──

  @Test
  fun `eulerDegreesToQuat matches DCL`() {
    for (c in dclVectors) sameQuat(eulerDegreesToQuat(vecOf(c.e)), c.q)
  }

  @Test
  fun `quatToEulerDegrees matches DCL toEulerAngles`() {
    for (c in dclVectors) {
      val out = quatToEulerDegrees(Quat(c.q[3], c.q[0], c.q[1], c.q[2]))
      near(out.x, c.back[0], 1e-4)
      near(out.y, c.back[1], 1e-4)
      near(out.z, c.back[2], 1e-4)
    }
  }

  @Test
  fun `round-trips to the same quaternion (incl pitch 90 and 135)`() {
    for (c in dclVectors) {
      val back = quatToEulerDegrees(eulerDegreesToQuat(vecOf(c.e)))
      sameQuat(eulerDegreesToQuat(back), c.q)
    }
  }

  // ── quaternion helpers ──

  @Test
  fun `quatFromAxisAngle matches the euler form for a single axis`() {
    sameQuat(quatFromAxisAngle(Axis.Y.unit, 90.0), doubleArrayOf(0.0, 0.7071067811865475, 0.0, 0.7071067811865476))
  }

  @Test
  fun `quatMultiply composes rotations`() {
    val q = quatMultiply(quatFromAxisAngle(Axis.Y.unit, 45.0), quatFromAxisAngle(Axis.Y.unit, 45.0))
    sameQuat(q, doubleArrayOf(0.0, 0.7071067811865475, 0.0, 0.7071067811865476))
  }

  // ── rayPlane ──

  @Test
  fun `rayPlane hits the plane`() {
    val hit = rayPlane(Ray(v(0.0, 1.0, 0.0), normalize(v(0.0, -1.0, 1.0))), v(0.0, 0.0, 0.0), v(0.0, 1.0, 0.0))!!
    near(hit.x, 0.0)
    near(hit.y, 0.0)
    near(hit.z, 1.0)
  }

  @Test
  fun `rayPlane is null for a ray parallel to the plane`() {
    assertNull(rayPlane(Ray(v(0.0, 0.0, 0.0), v(0.0, 0.0, 1.0)), v(0.0, 0.0, 0.0), v(0.0, 1.0, 0.0)))
  }

  @Test
  fun `rayPlane is null when the plane is behind the origin`() {
    assertNull(rayPlane(Ray(v(0.0, 1.0, 0.0), v(0.0, 1.0, 0.0)), v(0.0, 0.0, 0.0), v(0.0, 1.0, 0.0)))
  }

  // ── closestPointOnAxis ──

  @Test
  fun `closestPointOnAxis finds the point on the axis nearest the ray`() {
    val origin = v(0.0, 1.6, -5.0)
    val direction = normalize(v(2 - origin.x, 1 - origin.y, 0 - origin.z))
    val p = closestPointOnAxis(Ray(origin, direction), v(0.0, 1.0, 0.0), Axis.X.unit)!!
    near(p.x, 2.0)
    near(p.y, 1.0)
    near(p.z, 0.0)
  }

  @Test
  fun `closestPointOnAxis is null when the ray is parallel to the axis`() {
    assertNull(closestPointOnAxis(Ray(v(0.0, 2.0, 0.0), v(1.0, 0.0, 0.0)), v(0.0, 1.0, 0.0), Axis.X.unit))
  }

  // ── angleOnRing ──

  @Test
  fun `angleOnRing returns 0 on the reference direction and 90 a quarter turn on, each axis`() {
    // Each ray looks straight down the axis at a point on the ring plane.
    val cases =
        mapOf(
            Axis.X to (v(0.0, 1.0, 0.0) to v(0.0, 0.0, 1.0)),
            Axis.Y to (v(0.0, 0.0, 1.0) to v(1.0, 0.0, 0.0)),
            Axis.Z to (v(1.0, 0.0, 0.0) to v(0.0, 1.0, 0.0)),
        )
    val center = v(1.0, 2.0, 3.0)
    for ((axis, refQuarter) in cases) {
      val a = axis.unit
      fun at(d: Vec3): Double? {
        val target = v(center.x + d.x, center.y + d.y, center.z + d.z)
        val origin = v(center.x + a.x * 5, center.y + a.y * 5, center.z + a.z * 5)
        return angleOnRing(Ray(origin, normalize(v(target.x - origin.x, target.y - origin.y, target.z - origin.z))), center, a)
      }
      near(at(refQuarter.first)!!, 0.0)
      near(at(refQuarter.second)!!, 90.0)
    }
  }

  @Test
  fun `angleOnRing is null when the ray is parallel to the ring plane`() {
    assertNull(angleOnRing(Ray(v(0.0, 0.0, 5.0), v(1.0, 0.0, 0.0)), v(0.0, 0.0, 0.0), Axis.Z.unit))
  }

  // ── snap ──

  @Test
  fun `snap rounds to the nearest step`() {
    assertEquals(15.0, snap(22.0, 15.0), 0.0)
    assertEquals(30.0, snap(23.0, 15.0), 0.0)
    assertEquals(-15.0, snap(-8.0, 15.0), 0.0)
  }

  // ── rotateVector ──

  private fun nearVec(a: Vec3, b: Vec3) {
    near(a.x, b.x)
    near(a.y, b.y)
    near(a.z, b.z)
  }

  @Test
  fun `rotateVector turns local X to scene -Z at yaw 90`() {
    nearVec(rotateVector(eulerDegreesToQuat(v(0.0, 90.0, 0.0)), Axis.X.unit), v(0.0, 0.0, -1.0))
  }

  @Test
  fun `rotateVector matches DCL Vector3 rotate for a mixed rotation`() {
    nearVec(
        rotateVector(eulerDegreesToQuat(v(30.0, 45.0, 60.0)), v(1.0, 2.0, 3.0)),
        v(1.62566543473024, 0.11602540378443937, 3.36804839632687),
    )
  }

  @Test
  fun `rotateVector agrees with quatFromAxisAngle`() {
    val q = quatFromAxisAngle(Axis.Z.unit, 90.0)
    nearVec(rotateVector(q, Axis.X.unit), v(0.0, 1.0, 0.0))
    nearVec(rotateVector(q, Axis.Z.unit), v(0.0, 0.0, 1.0))
    val tilted = quatFromAxisAngle(v(1.0, 1.0, 0.0), 180.0)
    nearVec(rotateVector(tilted, Axis.X.unit), v(0.0, 1.0, 0.0))
  }

  @Test
  fun `rotateVector composes like quatMultiply (b first, then a)`() {
    val a = quatFromAxisAngle(Axis.Y.unit, 90.0)
    val b = quatFromAxisAngle(Axis.X.unit, 90.0)
    val p = v(0.3, -1.0, 2.0)
    nearVec(rotateVector(quatMultiply(a, b), p), rotateVector(a, rotateVector(b, p)))
  }
}
