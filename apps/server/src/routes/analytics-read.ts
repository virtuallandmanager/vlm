import type { FastifyInstance, FastifyReply } from 'fastify'
import { and, desc, eq, gte, inArray, lt, lte, or, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import {
  analyticsCopresenceDaily,
  analyticsEvents,
  analyticsHeatmapDaily,
  analyticsPositions,
  analyticsRollupHourly,
  analyticsScenes,
  analyticsSessions,
  accessGrants,
  orgMembers,
  sceneCollaborators,
  scenes,
} from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'
import { actorFromClaims } from '../auth/actor.js'
import { getAnalyticsAccess } from '../analytics/access.js'
import { verifiedWalletsOf } from '../analytics/claims.js'
import { visitorHash } from '../analytics/hash.js'

const DAY = 86_400_000
const HOUR = 3_600_000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_RANGE_DAYS = 400
const ts = (d: Date) => sql`${d.toISOString()}::timestamptz`
const rowsOf = <T>(r: unknown) => r as unknown as T[]
const startedCap = (cap: { started: Date | null }) => (cap.started ? sql` and started_at < ${ts(cap.started)}` : sql``)

function range(q: { from?: string; to?: string }): { from: Date; to: Date } | null {
  const to = q.to ? new Date(q.to) : new Date()
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - 7 * DAY)
  if (Number.isNaN(to.getTime()) || Number.isNaN(from.getTime()) || from > to) return null
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY) return null
  return { from, to }
}

/**
 * Upper bounds for a reader limited to data before `until` (a lapsed claimer): whole hourly and
 * daily buckets that end by `until`, and sessions that started before it. No limit without `until`.
 */
function caps(until: Date | undefined) {
  return {
    hour: until ? new Date(until.getTime() - HOUR) : null,
    day: until ? new Date(until.getTime() - DAY).toISOString().slice(0, 10) : null,
    started: until ?? null,
  }
}

function mergeCounts(objs: unknown[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const o of objs) for (const [k, v] of Object.entries((o as Record<string, number>) ?? {})) out[k] = (out[k] ?? 0) + Number(v)
  return out
}

export default async function analyticsReadRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  async function guard(request: { user: any }, reply: FastifyReply, id: string, manage = false) {
    const access = await getAnalyticsAccess(actorFromClaims(request.user), id)
    if (!access.scene) {
      reply.status(404).send({ error: 'Not found' })
      return null
    }
    if (!(manage ? access.canManage : access.canRead)) {
      reply.status(403).send({ error: 'Forbidden' })
      return null
    }
    return { ...access.scene, until: access.until }
  }

  app.get('/api/analytics/locations', async (request, reply) => {
    const actor = actorFromClaims(request.user)
    if (!actor.userId || !actor.verified) return reply.send({ scenes: [] })
    const candidate =
      actor.role === 'admin'
        ? undefined
        : or(
            eq(analyticsScenes.claimedByUserId, actor.userId),
            inArray(
              analyticsScenes.vlmSceneId,
              db
                .select({ id: scenes.id })
                .from(scenes)
                .where(
                  or(
                    eq(scenes.ownerId, actor.userId),
                    inArray(scenes.id, db.select({ id: sceneCollaborators.sceneId }).from(sceneCollaborators).where(eq(sceneCollaborators.userId, actor.userId))),
                    inArray(scenes.orgId, db.select({ id: orgMembers.orgId }).from(orgMembers).where(eq(orgMembers.userId, actor.userId))),
                    inArray(scenes.id, db.select({ id: accessGrants.sceneId }).from(accessGrants).where(eq(accessGrants.userId, actor.userId))),
                  ),
                ),
            ),
          )
    const all = await db.select().from(analyticsScenes).where(candidate)
    const readable: (typeof analyticsScenes.$inferSelect)[] = []
    for (const s of all) if ((await getAnalyticsAccess(actor, s.id)).canRead) readable.push(s)
    return reply.send({
      scenes: readable.map((s) => ({
        id: s.id,
        locationKey: s.locationKey,
        kind: s.kind,
        title: s.title,
        claimStatus: s.claimStatus,
        walletVisibility: s.walletVisibility,
        verifiedSessionShare: s.verifiedSessionShare,
      })),
    })
  })

  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>('/api/analytics/locations/:id/summary', async (request, reply) => {
    const r = range(request.query)
    if (!r) return reply.status(400).send({ error: 'from/to must be ISO dates with from <= to and a range of at most 400 days' })
    const scene = await guard(request, reply, request.params.id)
    if (!scene) return
    const cap = caps(scene.until)
    const rows = await db
      .select()
      .from(analyticsRollupHourly)
      .where(
        and(
          eq(analyticsRollupHourly.sceneId, scene.id),
          gte(analyticsRollupHourly.hour, r.from),
          lte(analyticsRollupHourly.hour, r.to),
          cap.hour ? lte(analyticsRollupHourly.hour, cap.hour) : undefined,
        ),
      )
    const sessions = rows.reduce((a, x) => a + x.sessions, 0)
    const [u] = rowsOf<{ n: number }>(
      await db.execute(sql`select count(distinct visitor_hash)::int as n from analytics_sessions where scene_id = ${scene.id} and started_at >= ${ts(r.from)} and started_at <= ${ts(r.to)}${startedCap(cap)}`),
    )
    return reply.send({
      sessions,
      uniqueVisitors: Number(u.n),
      newVisitors: rows.reduce((a, x) => a + x.newVisitors, 0),
      returningVisitors: rows.reduce((a, x) => a + x.returningVisitors, 0),
      peakConcurrency: rows.reduce((a, x) => Math.max(a, x.peakConcurrency), 0),
      dwellAvgSec: sessions ? Math.round(rows.reduce((a, x) => a + x.dwellAvgSec * x.sessions, 0) / sessions) : 0,
      verifiedShare: scene.verifiedSessionShare,
      interactions: mergeCounts(rows.map((x) => x.interactions)),
      emotes: mergeCounts(rows.map((x) => x.emotes)),
      countries: mergeCounts(rows.map((x) => x.countries)),
      platforms: mergeCounts(rows.map((x) => x.platforms)),
    })
  })

  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string; bucket?: string } }>(
    '/api/analytics/locations/:id/timeseries',
    async (request, reply) => {
      const r = range(request.query)
      const bucket = request.query.bucket === 'day' ? 'day' : 'hour'
      if (!r) return reply.status(400).send({ error: 'from/to must be ISO dates with from <= to and a range of at most 400 days' })
      const scene = await guard(request, reply, request.params.id)
      if (!scene) return
      const cap = caps(scene.until)
      const points = rowsOf<{ t: Date; sessions: number; unique_visitors: number; peak: number; dwell: number }>(
        await db.execute(sql`
          select date_trunc(${bucket}, hour) as t, sum(sessions)::int as sessions, sum(unique_visitors)::int as unique_visitors,
                 max(peak_concurrency)::int as peak,
                 coalesce(round(sum(dwell_avg_sec * sessions)::numeric / nullif(sum(sessions), 0)), 0)::int as dwell
          from analytics_rollup_hourly
          where scene_id = ${scene.id} and hour >= ${ts(r.from)} and hour <= ${ts(r.to)}${cap.hour ? sql` and hour <= ${ts(cap.hour)}` : sql``}
          group by 1 order by 1`),
      )
      const dayUniques = new Map<number, number>()
      if (bucket === 'day') {
        const rows = rowsOf<{ t: Date; n: number }>(
          await db.execute(sql`
            select date_trunc('day', started_at) as t, count(distinct visitor_hash)::int as n
            from analytics_sessions
            where scene_id = ${scene.id} and started_at >= ${ts(r.from)} and started_at <= ${ts(r.to)}${startedCap(cap)}
            group by 1`),
        )
        for (const u of rows) dayUniques.set(new Date(u.t).getTime(), Number(u.n))
      }
      return reply.send({
        points: points.map((p) => ({
          t: p.t,
          sessions: Number(p.sessions),
          uniqueVisitors: bucket === 'day' ? (dayUniques.get(new Date(p.t).getTime()) ?? 0) : Number(p.unique_visitors),
          peakConcurrency: Number(p.peak),
          dwellAvgSec: Number(p.dwell),
        })),
      })
    },
  )

  app.get<{ Params: { id: string } }>('/api/analytics/locations/:id/live', async (request, reply) => {
    const scene = await guard(request, reply, request.params.id)
    if (!scene) return
    // Live data is always after a lapse, so a reader limited by `until` sees nothing here.
    if (scene.until) return reply.send({ count: 0, positions: [] })
    const since = new Date(Date.now() - 60_000)
    const live = await db
      .select({ id: analyticsSessions.id })
      .from(analyticsSessions)
      .where(and(eq(analyticsSessions.sceneId, scene.id), gte(analyticsSessions.lastSeenAt, since)))
    const ids = live.map((s) => s.id)
    const positions = ids.length
      ? rowsOf<{ x: number; z: number }>(
          await db.execute(sql`
            select distinct on (session_id) x, z from analytics_positions
            where scene_id = ${scene.id} and session_id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
            order by session_id, occurred_at desc`),
        ).sort((a, b) => Number(a.x) - Number(b.x) || Number(a.z) - Number(b.z))
      : []
    return reply.send({ count: ids.length, positions: positions.map((p) => ({ x: Number(p.x), z: Number(p.z) })) })
  })

  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>('/api/analytics/locations/:id/heatmap', async (request, reply) => {
    const r = range(request.query)
    if (!r) return reply.status(400).send({ error: 'from/to must be ISO dates with from <= to and a range of at most 400 days' })
    const scene = await guard(request, reply, request.params.id)
    if (!scene) return
    const cap = caps(scene.until)
    const cells = rowsOf<{ x: number; z: number; dwell: number; visits: number }>(
      await db.execute(sql`
        select cell_x as x, cell_z as z, sum(dwell_sec)::int as dwell, sum(visits)::int as visits
        from analytics_heatmap_daily
        where scene_id = ${scene.id} and day >= ${r.from.toISOString().slice(0, 10)}::date and day <= ${r.to.toISOString().slice(0, 10)}::date${cap.day ? sql` and day <= ${cap.day}::date` : sql``}
        group by 1, 2 order by 1, 2`),
    )
    return reply.send({ cells: cells.map((c) => ({ x: Number(c.x), z: Number(c.z), dwellSec: Number(c.dwell), visits: Number(c.visits) })) })
  })

  app.get<{ Params: { id: string }; Querystring: { cursor?: string; limit?: string } }>('/api/analytics/locations/:id/sessions', async (request, reply) => {
    const scene = await guard(request, reply, request.params.id)
    if (!scene) return
    const limit = Math.min(Math.max(parseInt(request.query.limit || '50', 10) || 50, 1), 200)
    let where = and(eq(analyticsSessions.sceneId, scene.id), scene.until ? lt(analyticsSessions.startedAt, scene.until) : undefined)!
    if (request.query.cursor) {
      const [ts, id] = request.query.cursor.split('|')
      const t = new Date(ts)
      if (Number.isNaN(t.getTime()) || !id || !UUID_RE.test(id)) return reply.status(400).send({ error: 'invalid cursor' })
      where = and(where, or(lt(analyticsSessions.startedAt, t), and(eq(analyticsSessions.startedAt, t), lt(analyticsSessions.id, id))))!
    }
    const rows = await db
      .select()
      .from(analyticsSessions)
      .where(where)
      .orderBy(desc(analyticsSessions.startedAt), desc(analyticsSessions.id))
      .limit(limit + 1)
    const page = rows.slice(0, limit)
    const last = page.at(-1)
    return reply.send({
      sessions: page.map(({ visitorHash, wallet, ...s }) => ({ ...s, userId: visitorHash.slice(0, 16), walletAddress: wallet })),
      nextCursor: rows.length > limit && last ? `${last.startedAt.toISOString()}|${last.id}` : null,
    })
  })

  app.patch<{ Params: { id: string }; Body: { walletVisibility?: unknown } }>('/api/analytics/locations/:id', async (request, reply) => {
    if (typeof request.body?.walletVisibility !== 'boolean') return reply.status(400).send({ error: 'walletVisibility must be a boolean' })
    const scene = await guard(request, reply, request.params.id, true)
    if (!scene) return
    const on = request.body.walletVisibility
    const updated = await db.transaction(async (tx) => {
      const [row] = await tx.update(analyticsScenes).set({ walletVisibility: on, updatedAt: new Date() }).where(eq(analyticsScenes.id, scene.id)).returning()
      if (!on) await tx.update(analyticsSessions).set({ wallet: null, displayName: null }).where(eq(analyticsSessions.sceneId, scene.id))
      return row
    })
    return reply.send({ scene: { id: updated.id, walletVisibility: updated.walletVisibility } })
  })

  app.post('/api/analytics/me/delete', async (request, reply) => {
    const actor = actorFromClaims(request.user)
    if (!actor.userId || !actor.verified) return reply.status(403).send({ error: 'Forbidden' })
    const wallets = new Set(await verifiedWalletsOf(actor.userId))
    if (actor.wallet) wallets.add(actor.wallet)
    if (!wallets.size) return reply.status(400).send({ error: 'Sign in with your wallet to delete your visitor data' })
    const deleted = { sessions: 0, events: 0, positions: 0, copresence: 0 }
    const all = await db.select({ id: analyticsScenes.id, salt: analyticsScenes.salt }).from(analyticsScenes)
    for (const scene of all) {
      const hashes = [...wallets].map((w) => visitorHash(scene.salt, w))
      const sessions = await db
        .delete(analyticsSessions)
        .where(and(eq(analyticsSessions.sceneId, scene.id), inArray(analyticsSessions.visitorHash, hashes)))
        .returning({ id: analyticsSessions.id })
      deleted.sessions += sessions.length
      deleted.events += (await db.delete(analyticsEvents).where(and(eq(analyticsEvents.sceneId, scene.id), inArray(analyticsEvents.visitorHash, hashes))).returning({ id: analyticsEvents.id })).length
      if (sessions.length) {
        deleted.positions += (
          await db
            .delete(analyticsPositions)
            .where(and(eq(analyticsPositions.sceneId, scene.id), inArray(analyticsPositions.sessionId, sessions.map((s) => s.id))))
            .returning({ id: analyticsPositions.id })
        ).length
      }
      deleted.copresence += (
        await db
          .delete(analyticsCopresenceDaily)
          .where(and(eq(analyticsCopresenceDaily.sceneId, scene.id), or(inArray(analyticsCopresenceDaily.visitorA, hashes), inArray(analyticsCopresenceDaily.visitorB, hashes))))
          .returning({ day: analyticsCopresenceDaily.day })
      ).length
    }
    return reply.send({ deleted })
  })
}
