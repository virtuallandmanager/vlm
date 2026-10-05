import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { analyticsScenes, locationSetups } from '../db/schema.js'
import type { Actor } from '../auth/actor.js'
import { getSceneAccess, hasScope, isFullAccess, isHostAccess } from '../auth/permissions.js'

export interface AnalyticsAccess {
  canRead: boolean
  canManage: boolean
  /** Host-only: delete this location's analytics data. */
  canDelete: boolean
  scene: typeof analyticsScenes.$inferSelect | null
  /** Only data from this instant on (the reader's setup tenure start). */
  since?: Date
  /** Only data before this instant (an ended tenure). */
  until?: Date
}

const NONE = (scene: AnalyticsAccess['scene']): AnalyticsAccess => ({ canRead: false, canManage: false, canDelete: false, scene })

/** Analytics belong to setup tenures: a VLM scene's team reads the data recorded while its setup was active. */
export async function getAnalyticsAccess(actor: Actor, analyticsSceneId: string, now = new Date()): Promise<AnalyticsAccess> {
  const scene = (await db.query.analyticsScenes.findFirst({ where: eq(analyticsScenes.id, analyticsSceneId) })) ?? null
  if (!scene || !actor.userId || !actor.verified) return NONE(scene)
  if (actor.role === 'admin') return { canRead: true, canManage: true, canDelete: true, scene }

  const active = await db.query.locationSetups.findFirst({ where: and(eq(locationSetups.analyticsSceneId, scene.id), isNull(locationSetups.endedAt)) })
  if (active) {
    const access = await getSceneAccess(actor, active.vlmSceneId, now)
    if (hasScope(access, 'analytics.view')) {
      return { canRead: true, canManage: isFullAccess(access), canDelete: isHostAccess(access), scene, since: active.startedAt }
    }
  }
  const ended = await db.query.locationSetups.findMany({
    where: and(eq(locationSetups.analyticsSceneId, scene.id), isNotNull(locationSetups.endedAt)),
    orderBy: [desc(locationSetups.endedAt)],
  })
  for (const s of ended) {
    const access = await getSceneAccess(actor, s.vlmSceneId, now)
    if (hasScope(access, 'analytics.view')) return { canRead: true, canManage: false, canDelete: false, scene, since: s.startedAt, until: s.endedAt! }
  }
  return NONE(scene)
}
