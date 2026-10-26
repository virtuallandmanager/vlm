import { createHash, randomBytes } from 'node:crypto'
import { and, desc, eq, isNull, lte, ne, sql } from 'drizzle-orm'
import type { HyperfyAnalyticsBatch } from '@virvixr/shared'
import { db } from '../db/connection.js'
import { analyticsDirtyHours, analyticsEvents, analyticsPositions, analyticsScenes, analyticsSessions, locationSetups } from '../db/schema.js'
import { visitorHash } from '../analytics/hash.js'
import type { HyperfyWorldRow } from './worlds.js'

const hourOf = (t: number) => new Date(Math.floor(t / 3_600_000) * 3_600_000)

/** Session id derived from (world, player, the enter's t), formatted as a v4-shaped uuid. */
export function hyperfySessionId(worldId: string, playerId: string, enterT: number): string {
  const h = createHash('sha256').update(`${worldId}\n${playerId}\n${enterT}`).digest('hex')
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** Where a batch of visits is recorded: one analytics location, kept in step with its source (a Hyperfy world, an AR space). */
export type VisitTarget = {
  kind: 'hyperfy' | 'ar'
  /** The source's id; seeds session ids. */
  sourceId: string
  /** Prefix of the analytics location key and of the per-location visitor hash input (`<prefix>:<id>`, `<prefix>:<playerId>`). */
  keyPrefix: string
  realm: string
  platform: string
  title: string
  sceneId: string
  hostUserId: string | null
}

/** The location, created on first use and kept in step with its source. */
async function ensureLocation(tx: Tx, target: VisitTarget) {
  const locationKey = `${target.keyPrefix}:${target.sourceId}`
  await tx
    .insert(analyticsScenes)
    .values({
      kind: target.kind,
      locationKey,
      realm: target.realm,
      title: target.title,
      salt: randomBytes(32).toString('hex'),
      vlmSceneId: target.sceneId,
    })
    .onConflictDoNothing()
  const [scene] = await tx.select().from(analyticsScenes).where(eq(analyticsScenes.locationKey, locationKey))
  if (scene.title !== target.title || scene.vlmSceneId !== target.sceneId) {
    await tx.update(analyticsScenes).set({ title: target.title, vlmSceneId: target.sceneId, updatedAt: new Date() }).where(eq(analyticsScenes.id, scene.id))
  }
  // The setup row is what makes the location readable by the scene's team in the analytics overview.
  await tx
    .insert(locationSetups)
    .values({ analyticsSceneId: scene.id, vlmSceneId: target.sceneId, hostUserId: target.hostUserId })
    .onConflictDoNothing()
  return scene
}

/** Record a Hyperfy world's visitor events (see recordVisitBatch). */
export function recordHyperfyBatch(world: HyperfyWorldRow, batch: HyperfyAnalyticsBatch): Promise<{ accepted: number }> {
  return recordVisitBatch(
    { kind: 'hyperfy', sourceId: world.id, keyPrefix: 'hyperfy', realm: 'hyperfy', platform: 'hyperfy', title: world.name, sceneId: world.sceneId, hostUserId: world.ownerId },
    batch,
  )
}

/**
 * Record visitor events from a Hyperfy world or an AR space. Players have no wallets and no names are carried,
 * so sessions are unverified guests keyed by a per-location hash of `<keyPrefix>:<playerId>`.
 * writeBatch is DCL-shaped (one session per batch), so this writes directly.
 */
export async function recordVisitBatch(target: VisitTarget, batch: HyperfyAnalyticsBatch): Promise<{ accepted: number }> {
  return db.transaction(async (tx) => {
    const scene = await ensureLocation(tx, target)
    const open = new Map<string, { id: string; startedAt: number }>()
    const dirty = new Set<number>()
    let accepted = 0
    let lastT = 0

    const sessionFor = async (playerId: string, t: number) => {
      const known = open.get(playerId)
      if (known) return known
      const hash = visitorHash(scene.salt, `${target.keyPrefix}:${playerId}`)
      const [row] = await tx
        .select({ id: analyticsSessions.id, startedAt: analyticsSessions.startedAt })
        .from(analyticsSessions)
        .where(and(eq(analyticsSessions.sceneId, scene.id), eq(analyticsSessions.visitorHash, hash), isNull(analyticsSessions.endedAt), lte(analyticsSessions.startedAt, new Date(t))))
        .orderBy(desc(analyticsSessions.startedAt))
        .limit(1)
      if (!row) return null
      const s = { id: row.id, startedAt: row.startedAt.getTime() }
      open.set(playerId, s)
      return s
    }

    const touch = (sessionId: string, t: number, ended: boolean, count: number) =>
      tx
        .update(analyticsSessions)
        .set({
          lastSeenAt: sql`greatest(${analyticsSessions.lastSeenAt}, ${new Date(t).toISOString()}::timestamptz)`,
          durationSec: sql`extract(epoch from (greatest(${analyticsSessions.lastSeenAt}, ${new Date(t).toISOString()}::timestamptz) - ${analyticsSessions.startedAt}))::int`,
          eventCount: sql`${analyticsSessions.eventCount} + ${count}`,
          ...(ended ? { endedAt: new Date(t) } : {}),
        })
        .where(eq(analyticsSessions.id, sessionId))

    for (const e of batch.events) {
      lastT = Math.max(lastT, e.t)
      dirty.add(hourOf(e.t).getTime())
      const hash = visitorHash(scene.salt, `${target.keyPrefix}:${e.playerId}`)
      if (e.type === 'enter') {
        const id = hyperfySessionId(target.sourceId, e.playerId, e.t)
        const [prior] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(analyticsSessions)
          .where(and(eq(analyticsSessions.sceneId, scene.id), eq(analyticsSessions.visitorHash, hash), ne(analyticsSessions.id, id)))
        const created = await tx
          .insert(analyticsSessions)
          .values({
            id,
            sceneId: scene.id,
            visitorHash: hash,
            isGuest: true,
            verified: false,
            platform: target.platform,
            isReturning: prior.n > 0,
            startedAt: new Date(e.t),
            lastSeenAt: new Date(e.t),
            eventCount: 1,
          })
          .onConflictDoNothing()
          .returning({ id: analyticsSessions.id })
        open.set(e.playerId, { id, startedAt: e.t })
        if (created.length) {
          await tx.insert(analyticsEvents).values({ sceneId: scene.id, sessionId: id, seq: 0, visitorHash: hash, type: 'session.start', occurredAt: new Date(e.t), verified: false, data: { platform: target.platform } }).onConflictDoNothing()
          accepted++
        }
        continue
      }
      const s = await sessionFor(e.playerId, e.t)
      if (!s) continue // pos / leave with no open session: nothing to attach to
      if (e.type === 'pos') {
        if (e.x === undefined || e.y === undefined || e.z === undefined || [e.x, e.y, e.z].some((v) => Math.abs(v) > 32000)) continue
        // One position per session per second (seq = seconds since enter), so a re-sent batch changes nothing.
        const seq = 2 + Math.max(0, Math.floor((e.t - s.startedAt) / 1000))
        const added = await tx
          .insert(analyticsPositions)
          .values({ sceneId: scene.id, sessionId: s.id, seq, occurredAt: new Date(e.t), x: e.x, y: e.y, z: e.z })
          .onConflictDoNothing()
          .returning({ id: analyticsPositions.id })
        if (added.length) {
          accepted++
          await touch(s.id, e.t, false, 1)
        }
      } else {
        const added = await tx
          .insert(analyticsEvents)
          .values({ sceneId: scene.id, sessionId: s.id, seq: 1, visitorHash: hash, type: 'session.leave', occurredAt: new Date(e.t), verified: false })
          .onConflictDoNothing()
          .returning({ id: analyticsEvents.id })
        if (added.length) {
          accepted++
          await touch(s.id, e.t, true, 1)
          open.delete(e.playerId)
        }
      }
      dirty.add(hourOf(s.startedAt).getTime())
    }

    if (dirty.size) {
      await tx.insert(analyticsDirtyHours).values([...dirty].map((h) => ({ sceneId: scene.id, hour: new Date(h) }))).onConflictDoNothing()
    }
    if (lastT) {
      const seen = sql`${new Date(lastT).toISOString()}::timestamptz`
      await tx
        .update(analyticsScenes)
        .set({ lastActivityAt: sql`greatest(coalesce(${analyticsScenes.lastActivityAt}, ${seen}), ${seen})` })
        .where(eq(analyticsScenes.id, scene.id))
    }
    return { accepted }
  })
}
