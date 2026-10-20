import type { Vec3 } from 'vlm-shared'

type Triple = [number, number, number]

export interface HyperfyTransform {
  position: Triple
  rotation: Triple
  scale: Triple
}

const DEG = Math.PI / 180

/**
 * VLM (Decentraland, left-handed, +Z forward) to Hyperfy (three.js, right-handed). Position z is mirrored;
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
