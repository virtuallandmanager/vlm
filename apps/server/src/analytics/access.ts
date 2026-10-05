import { eq } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { analyticsScenes } from '../db/schema.js'
import type { Actor } from '../auth/actor.js'
import { getSceneAccess, isFullAccess } from '../auth/permissions.js'

const LAPSE_GRACE_MS = 30 * 86400_000

export interface AnalyticsAccess {
  canRead: boolean
  canManage: boolean
  scene: typeof analyticsScenes.$inferSelect | null
}

const NONE = (scene: AnalyticsAccess['scene']): AnalyticsAccess => ({ canRead: false, canManage: false, scene })

export async function getAnalyticsAccess(actor: Actor, analyticsSceneId: string, now = new Date()): Promise<AnalyticsAccess> {
  const scene = (await db.query.analyticsScenes.findFirst({ where: eq(analyticsScenes.id, analyticsSceneId) })) ?? null
  if (!scene || !actor.userId || !actor.verified) return NONE(scene)
  if (actor.role === 'admin') return { canRead: true, canManage: true, scene }
  if (scene.claimedByUserId === actor.userId) {
    if (scene.claimStatus === 'active') return { canRead: true, canManage: true, scene }
    if (scene.claimStatus === 'lapsed' && scene.lapsedAt && now.getTime() - scene.lapsedAt.getTime() < LAPSE_GRACE_MS) {
      return { canRead: true, canManage: false, scene }
    }
  }
  if (scene.vlmSceneId) {
    const access = await getSceneAccess(actor, scene.vlmSceneId, now)
    if (isFullAccess(access)) return { canRead: true, canManage: true, scene }
    if (access.level === 'editor' || access.level === 'viewer') return { canRead: true, canManage: false, scene }
  }
  return NONE(scene)
}
