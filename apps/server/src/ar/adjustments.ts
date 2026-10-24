import { and, eq } from 'drizzle-orm'
import type { Adjustment, SerializedScene, Vec3 } from 'vlm-shared'
import { db } from '../db/connection.js'
import { arAdjustments, sceneElementInstances, sceneElements, scenes } from '../db/schema.js'
import { publishSceneTouched } from '../realtime/bus.js'
import { isUuid } from '../auth/scene-from.js'
import { spaceScene } from './access.js'

const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const vec = (v: unknown, fallback: number): Vec3 => {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  return { x: num(o.x, fallback), y: num(o.y, fallback), z: num(o.z, fallback) }
}

/**
 * The scene with a space's adjustments applied: position += dPosition, rotation += dRotation (degrees, per
 * component), scale *= scaleFactor. Each adjusted instance also gets `arAdjusted: true` so the headset can mark it,
 * `arShared` (its transform before the adjustment) and `arAdjustment`, so the builder can show and edit both. Pure:
 * the input is left alone.
 */
export function applyAdjustments(scene: SerializedScene, adj: ReadonlyMap<string, Adjustment>): SerializedScene {
  if (!adj.size) return scene
  const out: SerializedScene = { ...scene }
  for (const [key, value] of Object.entries(scene)) {
    if (!Array.isArray(value)) continue
    out[key] = value.map((element) => {
      const instances = (element as { instances?: unknown }).instances
      if (!Array.isArray(instances)) return element
      return {
        ...element,
        instances: instances.map((instance) => {
          const a = adj.get((instance as { sk?: string }).sk ?? '')
          if (!a) return instance
          const i = instance as Record<string, unknown>
          const p = vec(i.position, 0)
          const r = vec(i.rotation, 0)
          const s = vec(i.scale, 1)
          return {
            ...i,
            position: { x: p.x + a.dPosition.x, y: p.y + a.dPosition.y, z: p.z + a.dPosition.z },
            rotation: { x: r.x + a.dRotation.x, y: r.y + a.dRotation.y, z: r.z + a.dRotation.z },
            scale: { x: s.x * a.scaleFactor.x, y: s.y * a.scaleFactor.y, z: s.z * a.scaleFactor.z },
            arAdjusted: true,
            arShared: { position: p, rotation: r, scale: s },
            arAdjustment: a,
          }
        }),
      }
    })
  }
  return out
}

export async function adjustmentsOf(spaceId: string): Promise<Map<string, Adjustment>> {
  const rows = await db.select().from(arAdjustments).where(eq(arAdjustments.spaceId, spaceId))
  return new Map(rows.map((r) => [r.instanceId, { dPosition: r.dPosition, dRotation: r.dRotation, scaleFactor: r.scaleFactor }]))
}

/** True when the instance belongs to an element of the scene's active preset. */
async function inActivePreset(sceneId: string, instanceId: string): Promise<boolean> {
  if (!isUuid(instanceId)) return false
  const [row] = await db
    .select({ id: sceneElementInstances.id })
    .from(sceneElementInstances)
    .innerJoin(sceneElements, eq(sceneElements.id, sceneElementInstances.elementId))
    .innerJoin(scenes, eq(scenes.activePresetId, sceneElements.presetId))
    .where(and(eq(sceneElementInstances.id, instanceId), eq(scenes.id, sceneId)))
  return !!row
}

/** 'instance_not_in_scene' when the instance is not in the scene's active preset; null when the space is unknown. */
export async function saveAdjustment(spaceId: string, instanceId: string, adj: Adjustment): Promise<'saved' | 'instance_not_in_scene' | null> {
  const sceneId = await spaceScene(spaceId)
  if (!sceneId) return null
  if (!(await inActivePreset(sceneId, instanceId))) return 'instance_not_in_scene'
  const values = { dPosition: adj.dPosition, dRotation: adj.dRotation, scaleFactor: adj.scaleFactor, updatedAt: new Date() }
  await db
    .insert(arAdjustments)
    .values({ spaceId, instanceId, ...values })
    .onConflictDoUpdate({ target: [arAdjustments.spaceId, arAdjustments.instanceId], set: values })
  await publishSceneTouched(sceneId)
  return 'saved'
}

/** Reset to shared. Idempotent; false only when the space is unknown. */
export async function clearAdjustment(spaceId: string, instanceId: string): Promise<boolean> {
  const sceneId = await spaceScene(spaceId)
  if (!sceneId) return false
  if (isUuid(instanceId)) await db.delete(arAdjustments).where(and(eq(arAdjustments.spaceId, spaceId), eq(arAdjustments.instanceId, instanceId)))
  await publishSceneTouched(sceneId)
  return true
}
