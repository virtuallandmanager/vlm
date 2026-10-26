// Platform-free vector/quaternion math for in-world editing. Conventions match the Decentraland SDK
// (left-handed, Euler degrees applied yaw(Y) / pitch(X) / roll(Z) like Quaternion.fromEulerDegrees),
// but vlm-core must not depend on @dcl packages, so the formulas are reproduced here.
import type { Vec3 } from '@virvixr/shared'

export type Quat = { x: number; y: number; z: number; w: number }
/** `direction` is expected to be normalized. */
export type Ray = { origin: Vec3; direction: Vec3 }
export type Axis = 'x' | 'y' | 'z'

export const AXIS_VECTORS: Record<Axis, Vec3> = {
  x: { x: 1, y: 0, z: 0 },
  y: { x: 0, y: 1, z: 0 },
  z: { x: 0, y: 0, z: 1 },
}

const DEG2RAD = Math.PI / 180
const RAD2DEG = 180 / Math.PI
const EPSILON = 1e-6

export const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z })
export const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
export const scale = (v: Vec3, s: number): Vec3 => ({ x: v.x * s, y: v.y * s, z: v.z * s })
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z
export const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
})
export const length = (v: Vec3): number => Math.sqrt(dot(v, v))
export function normalize(v: Vec3): Vec3 {
  const len = length(v)
  return len === 0 ? { x: 0, y: 0, z: 0 } : scale(v, 1 / len)
}

/** Same result as DCL `Quaternion.fromEulerDegrees(x, y, z)`. */
export function eulerDegreesToQuat(e: Vec3): Quat {
  const hp = e.x * DEG2RAD * 0.5
  const hy = e.y * DEG2RAD * 0.5
  const hr = e.z * DEG2RAD * 0.5
  const c1 = Math.cos(hp), s1 = Math.sin(hp)
  const c2 = Math.cos(hy), s2 = Math.sin(hy)
  const c3 = Math.cos(hr), s3 = Math.sin(hr)
  return {
    x: c2 * s1 * c3 + s2 * c1 * s3,
    y: s2 * c1 * c3 - c2 * s1 * s3,
    z: c2 * c1 * s3 - s2 * s1 * c3,
    w: c2 * c1 * c3 + s2 * s1 * s3,
  }
}

const repeat360 = (deg: number): number => deg - Math.floor(deg / 360) * 360

/** Same result as DCL `Quaternion.toEulerAngles(q)`, in degrees, each component in [0, 360). */
export function quatToEulerDegrees(q: Quat): Vec3 {
  const unit = q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w
  const test = q.x * q.w - q.y * q.z
  let x: number, y: number, z: number
  if (test > 0.4995 * unit) {
    x = Math.PI / 2
    y = 2 * Math.atan2(q.y, q.x)
    z = 0
  } else if (test < -0.4995 * unit) {
    x = -Math.PI / 2
    y = -2 * Math.atan2(q.y, q.x)
    z = 0
  } else {
    x = Math.asin(2 * (q.w * q.x - q.y * q.z))
    y = Math.atan2(2 * q.w * q.y + 2 * q.z * q.x, 1 - 2 * (q.x * q.x + q.y * q.y))
    z = Math.atan2(2 * q.w * q.z + 2 * q.x * q.y, 1 - 2 * (q.z * q.z + q.x * q.x))
  }
  return { x: repeat360(x * RAD2DEG), y: repeat360(y * RAD2DEG), z: repeat360(z * RAD2DEG) }
}

/** Hamilton product: the rotation that applies `b` first, then `a`. */
export function quatMultiply(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  }
}

export function quatFromAxisAngle(axis: Vec3, degrees: number): Quat {
  const n = normalize(axis)
  const half = degrees * DEG2RAD * 0.5
  const s = Math.sin(half)
  return { x: n.x * s, y: n.y * s, z: n.z * s, w: Math.cos(half) }
}

/** `v` turned by `q` (q·v·q⁻¹, same as DCL `Vector3.rotate(v, q)`); `q` is expected to be unit length. */
export function rotateVector(q: Quat, v: Vec3): Vec3 {
  const u = { x: q.x, y: q.y, z: q.z }
  const t = scale(cross(u, v), 2)
  return add(add(v, scale(t, q.w)), cross(u, t))
}

/** Where the ray meets the plane, or null if parallel or the hit is behind the origin. */
export function rayPlane(ray: Ray, planePoint: Vec3, planeNormal: Vec3): Vec3 | null {
  const denom = dot(ray.direction, planeNormal)
  if (Math.abs(denom) < EPSILON) return null
  const t = dot(sub(planePoint, ray.origin), planeNormal) / denom
  if (t < 0) return null
  return add(ray.origin, scale(ray.direction, t))
}

/** The point on the axis line (through `axisPoint`) nearest the ray, or null if the ray is parallel to it. */
export function closestPointOnAxis(ray: Ray, axisPoint: Vec3, axis: Vec3): Vec3 | null {
  const u = normalize(axis)
  const w0 = sub(ray.origin, axisPoint)
  const b = dot(ray.direction, u)
  const denom = 1 - b * b // ray.direction and u are unit length
  if (denom < EPSILON) return null
  const d = dot(ray.direction, w0)
  const e = dot(u, w0)
  return add(axisPoint, scale(u, (e - b * d) / denom))
}

/**
 * Signed angle (degrees, -180..180) of where the ray hits the ring plane around `axis`, measured from a fixed
 * reference direction (x: +y, y: +z, z: +x) toward `axis x reference`. Null if the ray misses the plane.
 */
export function angleOnRing(ray: Ray, center: Vec3, axis: Vec3): number | null {
  const n = normalize(axis)
  const hit = rayPlane(ray, center, n)
  if (!hit) return null
  const dominant: Axis = Math.abs(n.x) >= Math.abs(n.y) && Math.abs(n.x) >= Math.abs(n.z) ? 'x' : Math.abs(n.y) >= Math.abs(n.z) ? 'y' : 'z'
  const next: Record<Axis, Axis> = { x: 'y', y: 'z', z: 'x' }
  const ref = normalize(sub(AXIS_VECTORS[next[dominant]], scale(n, dot(AXIS_VECTORS[next[dominant]], n))))
  const quarter = cross(n, ref)
  const v = sub(hit, center)
  return Math.atan2(dot(v, quarter), dot(v, ref)) * RAD2DEG
}

export function snap(value: number, step: number): number {
  return Math.round(value / step) * step
}
