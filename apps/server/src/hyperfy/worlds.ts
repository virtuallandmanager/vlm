import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
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
  // An ended or failed hosted world no longer serves its feed: a failed one's cleanup may have left its machine
  // running. Self-run worlds are always 'running'.
  return row && row.status !== 'ended' && row.status !== 'failed' ? row : null
}

/** A random 32-byte world secret (hex). A hosted world's server holds it in VLM_WORLD_SECRET; only its hash is stored. */
export function createWorldSecret(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString('hex')
  return { raw, hash: hashWorldKey(raw) }
}

/** The live hosted world with this id whose secret this is; null for any other case (unknown, no secret, wrong secret, ended). */
export async function findWorldBySecret(worldId: string, secret: string): Promise<HyperfyWorldRow | null> {
  if (typeof worldId !== 'string' || !/^[0-9a-f-]{36}$/i.test(worldId) || typeof secret !== 'string' || !secret) return null
  const [row] = await db.select().from(hyperfyWorlds).where(eq(hyperfyWorlds.id, worldId))
  if (!row || !row.worldSecretHash || row.status === 'ended' || row.status === 'failed') return null
  const a = Buffer.from(row.worldSecretHash), b = Buffer.from(hashWorldKey(secret))
  return a.length === b.length && timingSafeEqual(a, b) ? row : null
}

export function worldSummary(w: HyperfyWorldRow): HyperfyWorldSummary {
  return {
    id: w.id,
    sceneId: w.sceneId,
    name: w.name,
    kind: w.kind === 'hosted' ? 'hosted' : 'self',
    address: w.address,
    status: w.status as HyperfyWorldSummary['status'],
    errorMessage: w.errorMessage,
    keyPrefix: w.keyPrefix,
    createdAt: w.createdAt.toISOString(),
    lastSeenAt: w.lastSeenAt ? w.lastSeenAt.toISOString() : null,
    endsAt: w.endsAt ? w.endsAt.toISOString() : null,
    endedAt: w.endedAt ? w.endedAt.toISOString() : null,
    purgeAfter: w.purgeAfter ? w.purgeAfter.toISOString() : null,
  }
}
