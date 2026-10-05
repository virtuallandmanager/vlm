import { randomBytes, randomUUID } from 'node:crypto'
import { db } from '../../src/db/connection.js'
import { analyticsScenes, analyticsSessions } from '../../src/db/schema.js'

let n = 0

export async function createAnalyticsScene(opts: Partial<typeof analyticsScenes.$inferInsert> = {}) {
  n++
  const [row] = await db
    .insert(analyticsScenes)
    .values({
      kind: 'parcels',
      locationKey: `gc:${n},${n}`,
      realm: 'main',
      baseParcel: `${n},${n}`,
      parcels: [`${n},${n}`],
      activeEntityId: `bafy${n}`,
      salt: randomBytes(32).toString('hex'),
      lastEntityCheckAt: new Date(),
      ...opts,
    })
    .returning()
  return row
}

export async function insertSession(sceneId: string, opts: Partial<typeof analyticsSessions.$inferInsert> = {}) {
  const startedAt = opts.startedAt ?? new Date(Date.now() - 2 * 60_000)
  const lastSeenAt = opts.lastSeenAt ?? new Date()
  const [row] = await db
    .insert(analyticsSessions)
    .values({
      id: randomUUID(),
      sceneId,
      visitorHash: opts.visitorHash ?? randomBytes(16).toString('hex'),
      platform: 'decentraland',
      startedAt,
      lastSeenAt,
      durationSec: Math.round((lastSeenAt.getTime() - startedAt.getTime()) / 1000),
      ...opts,
    })
    .returning()
  return row
}
