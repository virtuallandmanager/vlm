import type { FastifyInstance } from 'fastify'
import { and, desc, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { analyticsScenes, analyticsSessions } from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'
import { actorFromClaims } from '../auth/actor.js'
import { DirectoryUnavailableError, getDclDirectory, type DclDirectory } from '../analytics/dcl-directory.js'
import { ClaimError, claimScene, controlsAny, verifiedWalletsOf } from '../analytics/claims.js'

const MAX_DIRECTORY_CALLS = 100
class BudgetExhausted extends Error {}

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
      return reply.send(await claimScene(userId, request.body.locationKey, request.body.vlmSceneId))
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
    if (!userId) return reply.send({ scenes: [], truncated: false })
    const wallets = await verifiedWalletsOf(userId)
    if (!wallets.length) return reply.send({ scenes: [], truncated: false })
    const since = new Date(Date.now() - 30 * 86400_000)
    const activity = sql<Date>`max(${analyticsSessions.lastSeenAt})`
    const candidates = await db
      .select({ id: analyticsScenes.id, activity })
      .from(analyticsScenes)
      .innerJoin(analyticsSessions, eq(analyticsSessions.sceneId, analyticsScenes.id))
      .where(and(or(isNull(analyticsScenes.claimStatus), eq(analyticsScenes.claimStatus, 'lapsed')), gte(analyticsSessions.lastSeenAt, since)))
      .groupBy(analyticsScenes.id)
      .orderBy(desc(activity))
      .limit(50)
    if (!candidates.length) return reply.send({ scenes: [], truncated: false })
    const byId = new Map(
      (await db.select().from(analyticsScenes).where(inArray(analyticsScenes.id, candidates.map((c) => c.id)))).map((r) => [r.id, r]),
    )
    // Count directory calls through a wrapper so one request can never fan out unboundedly.
    const real = getDclDirectory()
    let calls = 0
    const spend = () => {
      if (++calls > MAX_DIRECTORY_CALLS) throw new BudgetExhausted()
    }
    const dir: DclDirectory = {
      ...real,
      getActiveSceneAt: (p) => (spend(), real.getActiveSceneAt(p)),
      getActiveDeployer: (p) => (spend(), real.getActiveDeployer(p)),
      getWorldScene: (n) => (spend(), real.getWorldScene(n)),
      getParcelRights: (p) => (spend(), real.getParcelRights(p)),
      getWorldOwner: (n) => (spend(), real.getWorldOwner(n)),
    }
    const out: Array<{ id: string; locationKey: string; title: string | null; kind: string }> = []
    let truncated = false
    for (const c of candidates) {
      const scene = byId.get(c.id)
      if (!scene) continue
      if (scene.kind === 'preview' && !wallets.some((w) => scene.locationKey.startsWith(`preview:${w}:`))) continue
      try {
        if (await controlsAny(scene, wallets, dir)) out.push({ id: scene.id, locationKey: scene.locationKey, title: scene.title, kind: scene.kind })
      } catch (err) {
        if (err instanceof BudgetExhausted) {
          truncated = true
          break
        }
        if (err instanceof DirectoryUnavailableError) {
          truncated = true
          continue
        }
        throw err
      }
    }
    return reply.send({ scenes: out, truncated })
  })
}
