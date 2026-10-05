import { and, eq, isNull, or } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { sceneRoles } from '../db/schema.js'
import type { Actor } from './actor.js'

export type SceneRole = 'cohost' | 'editor' | 'viewer'

/** The actor's active scene role, matched by user id or by their verified wallet (wallet only with `walletOnly`, for signed-fetch callers that have no user). Host is not a role (see scenes.ownerId). */
export async function sceneRoleFor(sceneId: string, actor: Actor, opts: { walletOnly?: boolean } = {}): Promise<SceneRole | null> {
  if (!actor.verified) return null
  if (opts.walletOnly) {
    if (!actor.wallet) return null
  } else if (!actor.userId) return null
  const subject = opts.walletOnly
    ? eq(sceneRoles.walletAddress, actor.wallet as string)
    : actor.wallet
    ? or(eq(sceneRoles.userId, actor.userId as string), eq(sceneRoles.walletAddress, actor.wallet))
    : eq(sceneRoles.userId, actor.userId as string)
  const rows = await db.select({ role: sceneRoles.role }).from(sceneRoles).where(and(eq(sceneRoles.sceneId, sceneId), isNull(sceneRoles.revokedAt), subject))
  if (rows.some((r) => r.role === 'cohost')) return 'cohost'
  if (rows.some((r) => r.role === 'editor')) return 'editor'
  return rows.length ? 'viewer' : null
}
