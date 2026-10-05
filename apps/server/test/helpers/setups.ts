import { eq } from 'drizzle-orm'
import { db } from '../../src/db/connection.js'
import { analyticsScenes, locationSetups } from '../../src/db/schema.js'

export async function createSetup(analyticsSceneId: string, vlmSceneId: string, opts: { startedAt?: Date; endedAt?: Date | null } = {}) {
  const [row] = await db
    .insert(locationSetups)
    .values({ analyticsSceneId, vlmSceneId, startedAt: opts.startedAt ?? new Date(Date.now() - 30 * 86400_000), endedAt: opts.endedAt ?? null, endReason: opts.endedAt ? 'redeployed' : null })
    .returning()
  if (!opts.endedAt) await db.update(analyticsScenes).set({ vlmSceneId }).where(eq(analyticsScenes.id, analyticsSceneId))
  return row
}
