import { and, eq, ne, sql } from 'drizzle-orm'
import type { IngestBatch } from 'vlm-shared'
import { db } from '../db/connection.js'
import { analyticsDirtyHours, analyticsScenes, analyticsEvents, analyticsPositions, analyticsSessions } from '../db/schema.js'
import type { AnalyticsSceneRow } from './registry.js'
import { visitorHash } from './hash.js'

export class SessionSceneMismatchError extends Error {}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const text = (v: unknown, max = 64) => (typeof v === 'string' && v ? v.slice(0, max) : null)
const hourOf = (t: number) => new Date(Math.floor(t / 3_600_000) * 3_600_000)

export async function writeBatch(input: {
  scene: AnalyticsSceneRow
  batch: IngestBatch
  verified: boolean
  signer: string | null
  country: string | null
  keepPosProbability: number
  random?: () => number
}): Promise<{ accepted: number }> {
  const { scene, batch, verified, signer, country, keepPosProbability } = input
  const random = input.random ?? Math.random
  const hash = visitorHash(scene.salt, batch.visitorId)
  const mayReveal = batch.noticeShown && !batch.isGuest && verified && signer !== null && signer === batch.visitorId.toLowerCase()
  const times = batch.events.map((e) => e.t)
  const startedAt = new Date(Math.min(...times))
  const lastSeenAt = new Date(Math.max(...times))
  const leave = batch.events.filter((e) => e.type === 'session.leave').map((e) => e.t)
  const start = batch.events.find((e) => e.type === 'session.start')?.data ?? {}

  const positions = batch.events
    .filter((e) => e.type === 'pos')
    .filter(() => keepPosProbability >= 1 || random() < keepPosProbability)
    .map((e) => ({ e, x: num(e.data?.x), y: num(e.data?.y), z: num(e.data?.z) }))
    .filter((p) => [p.x, p.y, p.z].every((v) => v !== null && Math.abs(v) <= 32000))
  const others = batch.events.filter((e) => e.type !== 'pos')

  return db.transaction(async (tx) => {
    // Decide reveal from the live flag (row lock serialises against the visibility toggle), not the cached scene.
    const [fresh] = await tx
      .select({ walletVisibility: analyticsScenes.walletVisibility })
      .from(analyticsScenes)
      .where(eq(analyticsScenes.id, scene.id))
      .for('update')
    const reveal = !!fresh?.walletVisibility && mayReveal
    const insertedEvents = others.length
      ? await tx
          .insert(analyticsEvents)
          .values(
            others.map((e) => ({
              sceneId: scene.id,
              sessionId: batch.sessionId,
              seq: e.seq,
              visitorHash: hash,
              type: e.type,
              occurredAt: new Date(e.t),
              verified,
              data: e.data ?? null,
            })),
          )
          .onConflictDoNothing()
          .returning({ id: analyticsEvents.id })
      : []
    const insertedPositions = positions.length
      ? await tx
          .insert(analyticsPositions)
          .values(
            positions.map(({ e, x, y, z }) => ({
              sceneId: scene.id,
              sessionId: batch.sessionId,
              seq: e.seq,
              occurredAt: new Date(e.t),
              x: x!,
              y: y!,
              z: z!,
              heading: (((Math.round(num(e.data?.ry) ?? 0) % 360) + 360) % 360),
              moving: e.data?.m === true,
            })),
          )
          .onConflictDoNothing()
          .returning({ id: analyticsPositions.id })
      : []
    const accepted = insertedEvents.length + insertedPositions.length

    const [prior] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(analyticsSessions)
      .where(and(eq(analyticsSessions.sceneId, scene.id), eq(analyticsSessions.visitorHash, hash), ne(analyticsSessions.id, batch.sessionId)))

    const endedAt = leave.length ? new Date(Math.max(...leave)) : null
    const upserted = await tx
      .insert(analyticsSessions)
      .values({
        id: batch.sessionId,
        sceneId: scene.id,
        visitorHash: hash,
        wallet: reveal ? signer : null,
        displayName: reveal ? text(batch.displayName) : null,
        isGuest: batch.isGuest,
        verified,
        platform: text(start.platform),
        device: text(start.device),
        realm: text(start.realm, 200),
        country,
        cameraMode: text(start.cameraMode, 16),
        isReturning: prior.n > 0,
        startedAt,
        lastSeenAt,
        endedAt,
        durationSec: Math.round((lastSeenAt.getTime() - startedAt.getTime()) / 1000),
        eventCount: accepted,
      })
      .onConflictDoUpdate({
        target: analyticsSessions.id,
        set: {
          startedAt: sql`least(${analyticsSessions.startedAt}, excluded.started_at)`,
          lastSeenAt: sql`greatest(${analyticsSessions.lastSeenAt}, excluded.last_seen_at)`,
          endedAt: sql`case
            when excluded.ended_at is not null then excluded.ended_at
            when ${analyticsSessions.endedAt} is not null and excluded.last_seen_at > ${analyticsSessions.endedAt} then null
            else ${analyticsSessions.endedAt} end`,
          durationSec: sql`extract(epoch from (greatest(${analyticsSessions.lastSeenAt}, excluded.last_seen_at) - least(${analyticsSessions.startedAt}, excluded.started_at)))::int`,
          eventCount: sql`${analyticsSessions.eventCount} + excluded.event_count`,
          verified: sql`${analyticsSessions.verified} or excluded.verified`,
          wallet: sql`coalesce(excluded.wallet, ${analyticsSessions.wallet})`,
          displayName: sql`coalesce(excluded.display_name, ${analyticsSessions.displayName})`,
          platform: sql`coalesce(${analyticsSessions.platform}, excluded.platform)`,
          device: sql`coalesce(${analyticsSessions.device}, excluded.device)`,
          realm: sql`coalesce(${analyticsSessions.realm}, excluded.realm)`,
          country: sql`coalesce(${analyticsSessions.country}, excluded.country)`,
          cameraMode: sql`coalesce(excluded.camera_mode, ${analyticsSessions.cameraMode})`,
        },
        setWhere: sql`${analyticsSessions.sceneId} = excluded.scene_id and ${analyticsSessions.visitorHash} = excluded.visitor_hash`,
      })
      .returning({ id: analyticsSessions.id, startedAt: analyticsSessions.startedAt })
    if (upserted.length === 0) throw new SessionSceneMismatchError('session id already belongs to another scene or visitor')

    // Sessions are rolled up in their start hour, so mark that hour dirty too.
    const hourSet = new Set(times.map((t) => hourOf(t).getTime()))
    hourSet.add(hourOf(upserted[0].startedAt.getTime()).getTime())
    const hours = [...hourSet].map((h) => ({ sceneId: scene.id, hour: new Date(h) }))
    await tx.insert(analyticsDirtyHours).values(hours).onConflictDoNothing()
    await tx
      .update(analyticsScenes)
      .set({ lastActivityAt: sql`greatest(coalesce(${analyticsScenes.lastActivityAt}, 'epoch'::timestamptz), ${lastSeenAt.toISOString()}::timestamptz)` })
      .where(eq(analyticsScenes.id, scene.id))
    return { accepted }
  })
}
