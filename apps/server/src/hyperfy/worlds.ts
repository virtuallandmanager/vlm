import { randomBytes, createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { HYPERFY_FEED, type HyperfyWorldSummary } from 'vlm-shared'
import { db } from '../db/connection.js'
import { hyperfyWorlds } from '../db/schema.js'

export type HyperfyWorldRow = typeof hyperfyWorlds.$inferSelect

export function hashWorldKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

/** A world key: `vlmw_` + 32 random bytes as hex. Only the hash is stored; the raw key is shown once. */
export function createWorldKey(): { raw: string; hash: string; prefix: string } {
  const raw = `${HYPERFY_FEED.keyPrefix}${randomBytes(32).toString('hex')}`
  return { raw, hash: hashWorldKey(raw), prefix: raw.slice(0, 12) }
}

export async function findWorldByKey(raw: string): Promise<HyperfyWorldRow | null> {
  if (!raw.startsWith(HYPERFY_FEED.keyPrefix)) return null
  const [row] = await db.select().from(hyperfyWorlds).where(eq(hyperfyWorlds.keyHash, hashWorldKey(raw)))
  return row ?? null
}

export function worldSummary(w: HyperfyWorldRow): HyperfyWorldSummary {
  return {
    id: w.id,
    sceneId: w.sceneId,
    name: w.name,
    kind: 'self',
    createdAt: w.createdAt.toISOString(),
    lastSeenAt: w.lastSeenAt ? w.lastSeenAt.toISOString() : null,
  }
}
