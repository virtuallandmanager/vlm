import { createHash } from 'node:crypto'
import type { ArSpaceWire, SerializedScene } from '@virvixr/shared'
import { sceneSnapshot } from '../hyperfy/snapshot.js'
import { adjustmentsOf, applyAdjustments } from './adjustments.js'
import { getSpace } from './spaces.js'

/**
 * A space with its scene (the space's adjustments applied), as the headset reads it, plus a version (SHA-256 of `{space, scene}`).
 * Null when the space (or its scene) doesn't exist. Draft spaces are returned too: the route decides who may see them.
 */
export async function arSpaceSnapshot(
  spaceId: string,
): Promise<{ version: string; space: ArSpaceWire; scene: SerializedScene | null; sceneId: string } | null> {
  const full = await getSpace(spaceId)
  if (!full) return null
  const snap = await sceneSnapshot(full.sceneId)
  if (!snap) return null
  const { sceneId, ...space } = full
  const scene = snap.scene && applyAdjustments(snap.scene, await adjustmentsOf(spaceId))
  return { version: createHash('sha256').update(JSON.stringify({ space, scene })).digest('hex'), space, scene, sceneId }
}
