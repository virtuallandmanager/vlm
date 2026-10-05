import type { FastifyInstance } from 'fastify'
import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { analyticsEvents, analyticsScenes, analyticsSessions, locationSetups } from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'
import { actorFromClaims } from '../auth/actor.js'
import { getSceneAccess } from '../auth/permissions.js'

const READ_LEVELS = new Set(['admin', 'owner', 'org', 'cohost', 'editor', 'viewer'])

/** Legacy dashboard endpoints keyed by VLM scene id, served from the new analytics tables. */
export default async function analyticsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  async function locate(request: { user: any }, vlmSceneId: string) {
    const actor = actorFromClaims(request.user)
    const access = await getSceneAccess(actor, vlmSceneId)
    if (!READ_LEVELS.has(access.level)) return { allowed: false as const }
    const scene = await db.query.analyticsScenes.findFirst({ where: eq(analyticsScenes.vlmSceneId, vlmSceneId) })
    // The VLM scene grants access to its location's analytics only while its setup is active, and only from its start.
    const active = scene ? await db.query.locationSetups.findFirst({ where: and(eq(locationSetups.analyticsSceneId, scene.id), isNull(locationSetups.endedAt)) }) : null
    if (scene && active?.vlmSceneId !== vlmSceneId && actor.role !== 'admin') return { allowed: false as const }
    return { allowed: true as const, scene, since: active?.startedAt }
  }

  app.get<{ Params: { sceneId: string } }>('/api/analytics/scenes/:sceneId/recent', async (request, reply) => {
    const found = await locate(request, request.params.sceneId)
    if (!found.allowed) return reply.status(403).send({ error: 'Forbidden' })
    if (!found.scene) return reply.send({ visitors: 0, actions: 0, activeSessions: 0, recentSessions: [] })
    const sceneId = found.scene.id
    const tenure = found.since
    const day = new Date(Date.now() - 86400_000)
    const since = tenure && tenure > day ? tenure : day
    const liveSince = new Date(Date.now() - 60_000)
    const [{ visitors }] = await db
      .select({ visitors: sql<number>`count(*)::int` })
      .from(analyticsSessions)
      .where(and(eq(analyticsSessions.sceneId, sceneId), gte(analyticsSessions.startedAt, since)))
    const [{ actions }] = await db
      .select({ actions: sql<number>`count(*)::int` })
      .from(analyticsEvents)
      .where(and(eq(analyticsEvents.sceneId, sceneId), gte(analyticsEvents.occurredAt, since)))
    const [{ active }] = await db
      .select({ active: sql<number>`count(*)::int` })
      .from(analyticsSessions)
      .where(and(eq(analyticsSessions.sceneId, sceneId), gte(analyticsSessions.lastSeenAt, liveSince), tenure ? gte(analyticsSessions.startedAt, tenure) : undefined))
    const recentSessions = await db
      .select({
        id: analyticsSessions.id,
        visitorHash: analyticsSessions.visitorHash,
        wallet: analyticsSessions.wallet,
        displayName: analyticsSessions.displayName,
        platform: analyticsSessions.platform,
        startedAt: analyticsSessions.startedAt,
        endedAt: analyticsSessions.endedAt,
      })
      .from(analyticsSessions)
      .where(and(eq(analyticsSessions.sceneId, sceneId), gte(analyticsSessions.startedAt, since)))
      .orderBy(desc(analyticsSessions.startedAt))
      .limit(50)
    return reply.send({
      visitors,
      actions,
      activeSessions: active,
      recentSessions: recentSessions.map(({ visitorHash, wallet, ...r }) => ({
        ...r,
        userId: visitorHash.slice(0, 16),
        walletAddress: wallet,
      })),
    })
  })

  app.get<{ Params: { sceneId: string }; Querystring: { limit?: string; offset?: string } }>(
    '/api/analytics/scenes/:sceneId/sessions',
    async (request, reply) => {
      const found = await locate(request, request.params.sceneId)
      if (!found.allowed) return reply.status(403).send({ error: 'Forbidden' })
      if (!found.scene) return reply.send({ sessions: [] })
      const limit = Math.min(Math.max(parseInt(request.query.limit || '50', 10) || 50, 1), 200)
      const offset = Math.max(parseInt(request.query.offset || '0', 10) || 0, 0)
      const rows = await db
        .select({
          id: analyticsSessions.id,
          visitorHash: analyticsSessions.visitorHash,
          wallet: analyticsSessions.wallet,
          displayName: analyticsSessions.displayName,
          platform: analyticsSessions.platform,
          device: analyticsSessions.device,
          realm: analyticsSessions.realm,
          country: analyticsSessions.country,
          cameraMode: analyticsSessions.cameraMode,
          isGuest: analyticsSessions.isGuest,
          verified: analyticsSessions.verified,
          isReturning: analyticsSessions.isReturning,
          startedAt: analyticsSessions.startedAt,
          lastSeenAt: analyticsSessions.lastSeenAt,
          endedAt: analyticsSessions.endedAt,
          durationSec: analyticsSessions.durationSec,
          eventCount: analyticsSessions.eventCount,
        })
        .from(analyticsSessions)
        .where(and(eq(analyticsSessions.sceneId, found.scene.id), found.since ? gte(analyticsSessions.startedAt, found.since) : undefined))
        .orderBy(desc(analyticsSessions.startedAt))
        .limit(limit)
        .offset(offset)
      const ids = rows.map((r) => r.id)
      const events = ids.length
        ? await db
            .select()
            .from(analyticsEvents)
            .where(inArray(analyticsEvents.sessionId, ids))
            .orderBy(analyticsEvents.occurredAt)
            .limit(ids.length * 100)
        : []
      const bySession = new Map<string, typeof events>()
      for (const e of events) bySession.set(e.sessionId, [...(bySession.get(e.sessionId) ?? []), e])
      const sessions = rows.map(({ visitorHash, wallet, ...r }) => ({
        id: r.id,
        userId: visitorHash.slice(0, 16),
        walletAddress: wallet,
        displayName: r.displayName,
        platform: r.platform,
        device: r.device,
        realm: r.realm,
        country: r.country,
        cameraMode: r.cameraMode,
        isGuest: r.isGuest,
        verified: r.verified,
        isReturning: r.isReturning,
        startedAt: r.startedAt,
        lastSeenAt: r.lastSeenAt,
        endedAt: r.endedAt,
        durationSec: r.durationSec,
        eventCount: r.eventCount,
        actions: (bySession.get(r.id) ?? []).map((e) => ({
          name: e.type === 'custom' ? (e.data as { name?: string } | null)?.name ?? 'custom' : e.type,
          metadata: e.data,
          createdAt: e.occurredAt,
        })),
      }))
      return reply.send({ sessions })
    },
  )
}
