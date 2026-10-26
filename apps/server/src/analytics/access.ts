import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { analyticsScenes, locationSetups } from '../db/schema.js'
import type { Actor } from '../auth/actor.js'
import { getSceneAccess, hasScope, isFullAccess, isHostAccess } from '../auth/permissions.js'
import { DirectoryUnavailableError } from './dcl-directory.js'
import { releaseIfRedeployed } from '../setup/setups.js'

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
  /** The Virvi scene of the tenure that granted read access. */
  vlmSceneId?: string
}

const NONE = (scene: AnalyticsAccess['scene']): AnalyticsAccess => ({ canRead: false, canManage: false, canDelete: false, scene })

/**
 * Analytics belong to setup tenures: a Virvi scene's team reads the data recorded while its setup was active.
 * `onlyVlmSceneId` (set for a scene pass) limits access to tenures of that one Virvi scene — no admin shortcut,
 * no reach through another scene's past setup at the same location.
 */
export async function getAnalyticsAccess(actor: Actor, analyticsSceneId: string, now = new Date(), onlyVlmSceneId?: string | null): Promise<AnalyticsAccess> {
  const restricted = onlyVlmSceneId !== undefined
  const scene = (await db.query.analyticsScenes.findFirst({ where: eq(analyticsScenes.id, analyticsSceneId) })) ?? null
  if (!scene || !actor.userId || !actor.verified) return NONE(scene)
  if (restricted && !onlyVlmSceneId) return NONE(scene)
  if (actor.role === 'admin' && !restricted) return { canRead: true, canManage: true, canDelete: true, scene, vlmSceneId: scene.vlmSceneId ?? undefined }

  let active = (await db.query.locationSetups.findFirst({ where: and(eq(locationSetups.analyticsSceneId, scene.id), isNull(locationSetups.endedAt)) })) ?? null
  // Ingest recorded a different live deployment than the setup's: check for a foreign redeploy here too,
  // so a release doesn't depend on someone opening the in-world HUD (2.0.0 clients and guests never do).
  if (active && scene.activeEntityId && active.deploymentEntityId && scene.activeEntityId !== active.deploymentEntityId) {
    try {
      active = await releaseIfRedeployed(active, scene, undefined, now)
    } catch (err) {
      if (!(err instanceof DirectoryUnavailableError)) throw err
      // Directory down: treat the setup as still active; the next read rechecks.
    }
  }
  if (active && (!restricted || active.vlmSceneId === onlyVlmSceneId)) {
    const access = await getSceneAccess(actor, active.vlmSceneId, now)
    if (hasScope(access, 'analytics.view')) {
      return { canRead: true, canManage: isFullAccess(access), canDelete: isHostAccess(access), scene, since: active.startedAt, vlmSceneId: active.vlmSceneId }
    }
  }
  const ended = await db.query.locationSetups.findMany({
    where: and(eq(locationSetups.analyticsSceneId, scene.id), isNotNull(locationSetups.endedAt)),
    orderBy: [desc(locationSetups.endedAt)],
  })
  for (const s of ended) {
    if (restricted && s.vlmSceneId !== onlyVlmSceneId) continue
    const access = await getSceneAccess(actor, s.vlmSceneId, now)
    if (hasScope(access, 'analytics.view')) return { canRead: true, canManage: false, canDelete: false, scene, since: s.startedAt, until: s.endedAt!, vlmSceneId: s.vlmSceneId }
  }
  return NONE(scene)
}
