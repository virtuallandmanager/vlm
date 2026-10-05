import type { FastifyInstance } from 'fastify'
import { and, desc, eq, gte, isNull, like, or, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { analyticsScenes } from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'
import { actorFromClaims } from '../auth/actor.js'
import { DirectoryUnavailableError, getDclDirectory, type DclDirectory } from '../analytics/dcl-directory.js'
import { hasDclAuthHeaders, verifyDclSignedFetch } from '../middleware/dcl-auth.js'
import { TokenBucketLimiter, checkRequesterLimits } from '../analytics/limiter.js'
import { ClaimError, controls, claimScene, controlsAny, verifiedWalletsOf } from '../analytics/claims.js'

const MAX_DIRECTORY_CALLS = 100
class BudgetExhausted extends Error {}

let signedLimiter = new TokenBucketLimiter()

/** Test hook. */
export function setSignedClaimLimiter(l: TokenBucketLimiter): void {
  signedLimiter = l
}

/** Unauthenticated-by-JWT eligibility probe for the in-world SDK. Never creates users, auth methods or sessions. */
export async function analyticsClaimSignedRoutes(app: FastifyInstance) {
  app.post<{ Body: { locationKey?: string } }>('/api/analytics/claims/check-signed', async (request, reply) => {
    const no = { eligible: false, known: false }
    const key = request.body?.locationKey
    const headers = request.headers as Record<string, string | string[] | undefined>
    const ipLimit = checkRequesterLimits(signedLimiter, { requesterKey: `ip:${request.ip}`, verified: false, eventCount: 1 })
    if (!ipLimit.ok) return reply.status(429).send({ error: 'rate_limited', retryAfter: Math.ceil(ipLimit.retryAfterMs / 1000) })
    if (typeof key !== 'string' || !key || !hasDclAuthHeaders(headers)) return reply.send(no)
    let wallet: string
    try {
      wallet = (await verifyDclSignedFetch(request.method, request.url.split('?')[0], headers)).walletAddress.toLowerCase()
    } catch {
      return reply.send(no)
    }
    const limit = checkRequesterLimits(signedLimiter, { requesterKey: `w:${wallet}`, verified: true, eventCount: 1 })
    if (!limit.ok) return reply.status(429).send({ error: 'rate_limited', retryAfter: Math.ceil(limit.retryAfterMs / 1000) })
    const scene = await db.query.analyticsScenes.findFirst({ where: eq(analyticsScenes.locationKey, key) })
    if (!scene) return reply.send(no)
    if (scene.claimStatus === 'active') {
      const claimer = scene.claimedByUserId ? await verifiedWalletsOf(scene.claimedByUserId) : []
      return reply.send({ eligible: claimer.includes(wallet), known: true })
    }
    try {
      return reply.send({ eligible: await controls(scene, wallet), known: true })
    } catch (err) {
      if (err instanceof DirectoryUnavailableError) return reply.send({ eligible: false, known: true })
      throw err
    }
  })
}

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
    const candidates = await db
      .select()
      .from(analyticsScenes)
      .where(
        and(
          or(isNull(analyticsScenes.claimStatus), eq(analyticsScenes.claimStatus, 'lapsed')),
          gte(analyticsScenes.lastActivityAt, since),
          or(sql`${analyticsScenes.kind} <> 'preview'`, ...wallets.map((w) => like(analyticsScenes.locationKey, `preview:${w}:%`))),
        ),
      )
      .orderBy(desc(analyticsScenes.lastActivityAt))
      .limit(50)
    if (!candidates.length) return reply.send({ scenes: [], truncated: false })
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
    let failures = 0
    for (const scene of candidates) {
      try {
        const ok = await controlsAny(scene, wallets, dir)
        failures = 0
        if (ok) out.push({ id: scene.id, locationKey: scene.locationKey, title: scene.title, kind: scene.kind })
      } catch (err) {
        if (err instanceof BudgetExhausted) {
          truncated = true
          break
        }
        if (err instanceof DirectoryUnavailableError) {
          truncated = true
          if (++failures >= 3) break // Decentraland is down; fail fast
          continue
        }
        throw err
      }
    }
    return reply.send({ scenes: out, truncated })
  })
}
