import type { FastifyInstance } from 'fastify'
import { and, eq, gte, inArray, isNull, or } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { analyticsScenes, analyticsSessions } from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'
import { actorFromClaims } from '../auth/actor.js'
import { DirectoryUnavailableError } from '../analytics/dcl-directory.js'
import { ClaimError, claimScene, controlsAny, verifiedWalletsOf } from '../analytics/claims.js'

export default async function analyticsClaimRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  const userOf = (request: { user: any }) => {
    const a = actorFromClaims(request.user)
    return a.userId && a.verified ? a.userId : null
  }

  app.post<{ Body: { locationKey?: string; vlmSceneId?: string } }>('/api/analytics/claims', async (request, reply) => {
    const userId = userOf(request)
    if (!userId) return reply.status(403).send({ error: 'Forbidden' })
    if (!request.body?.locationKey) return reply.status(400).send({ error: 'locationKey is required' })
    try {
      return reply.send({ scene: await claimScene(userId, request.body.locationKey, request.body.vlmSceneId) })
    } catch (err) {
      if (err instanceof ClaimError) return reply.status(err.status).send({ error: err.message })
      throw err
    }
  })

  app.get<{ Querystring: { locationKey?: string } }>('/api/analytics/claims/check', async (request, reply) => {
    const userId = userOf(request)
    const key = request.query.locationKey
    if (!userId || !key) return reply.send({ eligible: false, claimed: false, mine: false })
    const scene = await db.query.analyticsScenes.findFirst({ where: eq(analyticsScenes.locationKey, key) })
    if (!scene) return reply.send({ eligible: false, claimed: false, mine: false })
    const claimed = scene.claimStatus === 'active'
    const mine = claimed && scene.claimedByUserId === userId
    try {
      const eligible = mine || (!claimed && (await controlsAny(scene, await verifiedWalletsOf(userId))))
      return reply.send({ eligible, claimed, mine })
    } catch (err) {
      if (err instanceof DirectoryUnavailableError) return reply.status(503).send({ error: 'upstream_unavailable', retryAfter: 30 })
      throw err
    }
  })

  app.get('/api/analytics/claims/eligible', async (request, reply) => {
    const userId = userOf(request)
    if (!userId) return reply.send({ scenes: [] })
    const wallets = await verifiedWalletsOf(userId)
    if (!wallets.length) return reply.send({ scenes: [] })
    const since = new Date(Date.now() - 30 * 86400_000)
    const candidates = await db
      .selectDistinct({ id: analyticsScenes.id })
      .from(analyticsScenes)
      .innerJoin(analyticsSessions, eq(analyticsSessions.sceneId, analyticsScenes.id))
      .where(and(or(isNull(analyticsScenes.claimStatus), eq(analyticsScenes.claimStatus, 'lapsed')), gte(analyticsSessions.lastSeenAt, since)))
      .limit(50)
    if (!candidates.length) return reply.send({ scenes: [] })
    const rows = await db.select().from(analyticsScenes).where(inArray(analyticsScenes.id, candidates.map((c) => c.id)))
    const out: Array<{ id: string; locationKey: string; title: string | null; kind: string }> = []
    for (const scene of rows) {
      try {
        if (await controlsAny(scene, wallets)) out.push({ id: scene.id, locationKey: scene.locationKey, title: scene.title, kind: scene.kind })
      } catch (err) {
        if (err instanceof DirectoryUnavailableError) return reply.status(503).send({ error: 'upstream_unavailable', retryAfter: 30 })
        throw err
      }
    }
    return reply.send({ scenes: out })
  })
}
