import type { Vec3 } from '@virvixr/shared'

type Triple = [number, number, number]

export interface HyperfyTransform {
  position: Triple
  rotation: Triple
  scale: Triple
}

const DEG = Math.PI / 180

/**
 * Virvi (Decentraland, left-handed, +Z forward) to Hyperfy (three.js, right-handed). Position z is mirrored;
 * rotation goes degrees to radians with x and y negated (a z-mirror flips turns about x and y), and keeps
 * Decentraland's yaw-pitch-roll order, which is three.js 'YXZ'. Scale is unchanged.
 */
export function toHyperfyTransform(t: { position: Vec3; rotation: Vec3; scale: Vec3 }): HyperfyTransform {
  return {
    position: [t.position.x, t.position.y, -t.position.z],
    rotation: [-t.rotation.x * DEG, -t.rotation.y * DEG, t.rotation.z * DEG],
    scale: [t.scale.x, t.scale.y, t.scale.z],
  }
}

/**
 * The turn a loaded model gets inside the group that carries its mapped transform. Decentraland shows a glTF
 * x-mirrored (glTF (x, y, z) at (-x, y, z)); with the z-mirror above that is a half turn about Y in Hyperfy.
 * The half turn, diag(-1, 1, -1), commutes with scale, so the group can keep the Virvi scale.
 */
export const MODEL_TURN: Triple = [0, Math.PI, 0]

type XYZ = { x: number; y: number; z: number }

/** A world position in the app's local frame, given the inverse of the app root's world matrix (three.js Matrix4). */
export function worldToLocal(p: XYZ, inverse: { elements: ArrayLike<number> }): XYZ {
  const e = inverse.elements // column-major
  return {
    x: e[0] * p.x + e[4] * p.y + e[8] * p.z + e[12],
    y: e[1] * p.x + e[5] * p.y + e[9] * p.z + e[13],
    z: e[2] * p.x + e[6] * p.y + e[10] * p.z + e[14],
  }
}

/** An app-local Hyperfy position back in Virvi terms: the inverse of toHyperfyTransform's position mapping. */
export function toVirviPosition(local: XYZ): Vec3 {
  return { x: local.x, y: local.y, z: -local.z }
}
