import { describe, it, expect } from 'vitest'
import {
  eulerDegreesToQuat,
  quatToEulerDegrees,
  rayPlane,
  closestPointOnAxis,
  angleOnRing,
  snap,
  normalize,
  AXIS_VECTORS,
  quatMultiply,
  quatFromAxisAngle,
  rotateVector,
  type Axis,
} from '../src/transform/math.js'

// Generated once from the DCL math (@dcl/ecs-math 2.1.0, as used by @dcl/sdk/math) with
// Quaternion.fromEulerDegrees(e) and Quaternion.toEulerAngles(q). Pasted so vlm-core has no @dcl dependency.
const DCL_VECTORS: { e: [number, number, number]; q: [number, number, number, number]; back: [number, number, number] }[] = [
  { e: [0, 0, 0], q: [0, 0, 0, 1], back: [0, 0, 0] },
  { e: [0, 90, 0], q: [0, 0.7071067811865475, 0, 0.7071067811865476], back: [0, 89.99999999999999, 0] },
  { e: [90, 0, 0], q: [0.7071067811865475, 0, 0, 0.7071067811865476], back: [90, 0, 0] },
  { e: [0, 0, 90], q: [0, 0, 0.7071067811865475, 0.7071067811865476], back: [0, 0, 89.99999999999999] },
  { e: [30, 45, 60], q: [0.3919038373291199, 0.20056212114657512, 0.3604234056503559, 0.8223631719059994], back: [29.999999999999993, 45, 59.99999999999999] },
  { e: [90, 30, 0], q: [0.6830127018922193, 0.18301270189221933, -0.1830127018922193, 0.6830127018922194], back: [90, 29.999999999999996, 0] },
  { e: [135, 20, 10], q: [0.9121731942755071, -0.013098696101331922, -0.12697316175171494, 0.38941790405737065], back: [45.00000000000001, 200, 190] },
  { e: [-45, 200, 15], q: [0.18464220931146905, 0.8933861241002776, 0.35270512272218274, -0.2082488516443552], back: [315, 200, 14.999999999999993] },
]

const near = (a: number, b: number, eps = 1e-5) => expect(Math.abs(a - b)).toBeLessThan(eps)
const sameQuat = (a: { x: number; y: number; z: number; w: number }, b: [number, number, number, number]) => {
  const d = a.x * b[0] + a.y * b[1] + a.z * b[2] + a.w * b[3]
  const s = d < 0 ? -1 : 1
  near(a.x, s * b[0])
  near(a.y, s * b[1])
  near(a.z, s * b[2])
  near(a.w, s * b[3])
}

describe('euler <-> quaternion (DCL convention)', () => {
  it.each(DCL_VECTORS)('eulerDegreesToQuat matches DCL for $e', ({ e, q }) => {
    sameQuat(eulerDegreesToQuat({ x: e[0], y: e[1], z: e[2] }), q)
  })

  it.each(DCL_VECTORS)('quatToEulerDegrees matches DCL toEulerAngles for $e', ({ q, back }) => {
    const out = quatToEulerDegrees({ x: q[0], y: q[1], z: q[2], w: q[3] })
    near(out.x, back[0], 1e-4)
    near(out.y, back[1], 1e-4)
    near(out.z, back[2], 1e-4)
  })

  it.each(DCL_VECTORS)('round-trips to the same quaternion for $e (incl. pitch 90 and 135)', ({ e, q }) => {
    const back = quatToEulerDegrees(eulerDegreesToQuat({ x: e[0], y: e[1], z: e[2] }))
    sameQuat(eulerDegreesToQuat(back), q)
  })
})

describe('quaternion helpers', () => {
  it('quatFromAxisAngle matches the euler form for a single axis', () => {
    const q = quatFromAxisAngle(AXIS_VECTORS.y, 90)
    sameQuat(q, [0, 0.7071067811865475, 0, 0.7071067811865476])
  })
  it('quatMultiply composes rotations (a then b applied as a*b)', () => {
    const q = quatMultiply(quatFromAxisAngle(AXIS_VECTORS.y, 45), quatFromAxisAngle(AXIS_VECTORS.y, 45))
    sameQuat(q, [0, 0.7071067811865475, 0, 0.7071067811865476])
  })
})

describe('rayPlane', () => {
  it('hits the plane', () => {
    const hit = rayPlane({ origin: { x: 0, y: 1, z: 0 }, direction: normalize({ x: 0, y: -1, z: 1 }) }, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 })
    near(hit!.x, 0)
    near(hit!.y, 0)
    near(hit!.z, 1)
  })
  it('is null for a ray parallel to the plane', () => {
    expect(rayPlane({ origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: 1 } }, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 })).toBeNull()
  })
  it('is null when the plane is behind the origin', () => {
    expect(rayPlane({ origin: { x: 0, y: 1, z: 0 }, direction: { x: 0, y: 1, z: 0 } }, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 })).toBeNull()
  })
})

describe('closestPointOnAxis', () => {
  it('finds the point on the axis nearest the ray', () => {
    const origin = { x: 0, y: 1.6, z: -5 }
    const direction = normalize({ x: 2 - origin.x, y: 1 - origin.y, z: 0 - origin.z })
    const p = closestPointOnAxis({ origin, direction }, { x: 0, y: 1, z: 0 }, AXIS_VECTORS.x)
    near(p!.x, 2)
    near(p!.y, 1)
    near(p!.z, 0)
  })
  it('is null when the ray is parallel to the axis', () => {
    expect(closestPointOnAxis({ origin: { x: 0, y: 2, z: 0 }, direction: { x: 1, y: 0, z: 0 } }, { x: 0, y: 1, z: 0 }, AXIS_VECTORS.x)).toBeNull()
  })
})

describe('angleOnRing', () => {
  // Each ray looks straight down the axis at a point on the ring plane.
  const cases: Record<Axis, { ref: [number, number, number]; quarter: [number, number, number] }> = {
    x: { ref: [0, 1, 0], quarter: [0, 0, 1] },
    y: { ref: [0, 0, 1], quarter: [1, 0, 0] },
    z: { ref: [1, 0, 0], quarter: [0, 1, 0] },
  }
  const center = { x: 1, y: 2, z: 3 }
  for (const axis of ['x', 'y', 'z'] as Axis[]) {
    it(`returns 0 on the reference direction and 90 a quarter turn on, axis ${axis}`, () => {
      const a = AXIS_VECTORS[axis]
      const at = (v: [number, number, number]) => {
        const target = { x: center.x + v[0], y: center.y + v[1], z: center.z + v[2] }
        const origin = { x: center.x + a.x * 5, y: center.y + a.y * 5, z: center.z + a.z * 5 }
        return angleOnRing({ origin, direction: normalize({ x: target.x - origin.x, y: target.y - origin.y, z: target.z - origin.z }) }, center, a)
      }
      near(at(cases[axis].ref)!, 0)
      near(at(cases[axis].quarter)!, 90)
    })
  }
  it('is null when the ray is parallel to the ring plane', () => {
    expect(angleOnRing({ origin: { x: 0, y: 0, z: 5 }, direction: { x: 1, y: 0, z: 0 } }, { x: 0, y: 0, z: 0 }, AXIS_VECTORS.z)).toBeNull()
  })
})

describe('snap', () => {
  it('rounds to the nearest step', () => {
    expect(snap(22, 15)).toBe(15)
    expect(snap(23, 15)).toBe(30)
    expect(snap(-8, 15)).toBe(-15)
  })
})

describe('rotateVector', () => {
  const nearVec = (a: { x: number; y: number; z: number }, b: [number, number, number]) => {
    near(a.x, b[0])
    near(a.y, b[1])
    near(a.z, b[2])
  }
  it('turns local X to scene -Z at yaw 90 (DCL Vector3.rotate)', () => {
    nearVec(rotateVector(eulerDegreesToQuat({ x: 0, y: 90, z: 0 }), AXIS_VECTORS.x), [0, 0, -1])
  })
  it('matches DCL Vector3.rotate for a mixed rotation', () => {
    // Vector3.rotate(Vector3.create(1, 2, 3), Quaternion.fromEulerDegrees(30, 45, 60)) from @dcl/ecs-math 2.1.0
    nearVec(rotateVector(eulerDegreesToQuat({ x: 30, y: 45, z: 60 }), { x: 1, y: 2, z: 3 }), [1.62566543473024, 0.11602540378443937, 3.36804839632687])
  })
  it('agrees with quatFromAxisAngle: a quarter turn about Z takes X to Y, and the axis stays put', () => {
    const q = quatFromAxisAngle(AXIS_VECTORS.z, 90)
    nearVec(rotateVector(q, AXIS_VECTORS.x), [0, 1, 0])
    nearVec(rotateVector(q, AXIS_VECTORS.z), [0, 0, 1])
    const tilted = quatFromAxisAngle({ x: 1, y: 1, z: 0 }, 180)
    nearVec(rotateVector(tilted, AXIS_VECTORS.x), [0, 1, 0])
  })
  it('composes like quatMultiply (b first, then a)', () => {
    const a = quatFromAxisAngle(AXIS_VECTORS.y, 90)
    const b = quatFromAxisAngle(AXIS_VECTORS.x, 90)
    const v = { x: 0.3, y: -1, z: 2 }
    const once = rotateVector(quatMultiply(a, b), v)
    const twice = rotateVector(a, rotateVector(b, v))
    nearVec(once, [twice.x, twice.y, twice.z])
  })
})
