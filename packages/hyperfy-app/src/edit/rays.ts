/**
 * Pointer rays for edit mode. Hyperfy gives scripts the camera rig's pose (`control.camera`: position, quaternion,
 * zoom) and the pointer's screen coordinates, but not the field of view, so unlocked rays assume Hyperfy's default.
 */
import type { Ray } from '@virvixr/core/transform/math'
import { normalize, rotateVector } from '@virvixr/core/transform/math'

type XYZ = { x: number; y: number; z: number }
type Quat = { x: number; y: number; z: number; w: number }

/**
 * Hyperfy's vertical field of view in degrees: `new THREE.PerspectiveCamera(70, 0, 0.2, 1200)` in
 * src/core/World.js (line 36 in Hyperfy 0.16); nothing else changes `camera.fov`.
 */
export const HYPERFY_DEFAULT_FOV = 70

export interface PointerCamera {
  /** The camera rig (`control.camera.position`). */
  position: XYZ
  quaternion: Quat
  /** `control.camera.zoom`: the camera sits this far behind the rig along its local +z (third person). */
  zoom?: number
}

/** Hyperfy's `control.pointer.coords` (0..1 across the viewport, y down) and the viewport's width / height. */
export interface PointerCoords {
  x: number
  y: number
  aspect: number
}

/**
 * The world-space ray under the pointer. A locked pointer (`null`) is the camera's forward ray, which is what
 * Hyperfy's reticle raycast uses; an unlocked one goes through the pointer for a camera of `fovDeg`.
 */
export function pointerRay(camera: PointerCamera, pointer: PointerCoords | null, fovDeg = HYPERFY_DEFAULT_FOV): Ray {
  const q = camera.quaternion
  const back = rotateVector(q, { x: 0, y: 0, z: camera.zoom ?? 0 })
  const origin = { x: camera.position.x + back.x, y: camera.position.y + back.y, z: camera.position.z + back.z }
  if (!pointer) return { origin, direction: normalize(rotateVector(q, { x: 0, y: 0, z: -1 })) }
  const tan = Math.tan((fovDeg * Math.PI) / 360)
  const ndcX = pointer.x * 2 - 1
  const ndcY = 1 - pointer.y * 2
  const local = normalize({ x: ndcX * tan * pointer.aspect, y: ndcY * tan, z: -1 })
  return { origin, direction: normalize(rotateVector(q, local)) }
}

/**
 * A world-space Hyperfy ray in VLM coordinates: into the app root's frame with the inverse of its world matrix
 * (three.js Matrix4, column-major; omitted means the root is the world origin), then z mirrored (see transform.ts).
 */
export function toVlmRay(ray: Ray, inverse?: { elements: ArrayLike<number> }): Ray {
  let { origin: o, direction: d } = ray
  if (inverse) {
    const e = inverse.elements
    o = {
      x: e[0] * o.x + e[4] * o.y + e[8] * o.z + e[12],
      y: e[1] * o.x + e[5] * o.y + e[9] * o.z + e[13],
      z: e[2] * o.x + e[6] * o.y + e[10] * o.z + e[14],
    }
    d = normalize({
      x: e[0] * d.x + e[4] * d.y + e[8] * d.z,
      y: e[1] * d.x + e[5] * d.y + e[9] * d.z,
      z: e[2] * d.x + e[6] * d.y + e[10] * d.z,
    })
  }
  return { origin: { x: o.x, y: o.y, z: -o.z }, direction: { x: d.x, y: d.y, z: -d.z } }
}
