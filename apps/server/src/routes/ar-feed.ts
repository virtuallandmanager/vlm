import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { AR_FEED, type ArFeedResponse, type ArMarkerLookup } from 'vlm-shared'
import { authenticate } from '../middleware/auth.js'
import { actorFromClaims } from '../auth/actor.js'
import { getSceneAccess } from '../auth/permissions.js'
import { fromSpace, markerByCode, markerSceneByCode, mayBuild, spaceScene } from '../ar/access.js'
import { arSpaceSnapshot } from '../ar/snapshot.js'
import { longPoll } from '../http/long-poll.js'
import { TokenBucketLimiter } from '../analytics/limiter.js'

let holdMs: number = AR_FEED.holdMs

// Per IP: a headset polls about 3 times a minute, plus bursts on edits and errors.
export const AR_FEED_LIMIT = { capacity: 120, refillPerSec: 2 }
let limiter = new TokenBucketLimiter()

/** Test hook. */
export function setArFeedLimiter(l: TokenBucketLimiter): void {
  limiter = l
}

/** Test hook. */
export function setArFeedHoldMs(ms: number): void {
  holdMs = ms
}

/**
 * Sign-in is optional here: no Authorization header is a visitor. A header is checked like any other, before
 * anything else is looked up (`authenticate`, which also holds a scene pass to this route's scene and refuses
 * the other kinds of pass). Returns false when `authenticate` already answered.
 */
async function signInIfPresent(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  if (!request.headers.authorization) return true
  await authenticate(request, reply)
  return !reply.sent
}

/** Whether the signed-in caller (if any) may build in the scene. */
async function isBuilder(request: FastifyRequest, sceneId: string): Promise<boolean> {
  if (!request.headers.authorization) return false
  return mayBuild(await getSceneAccess(actorFromClaims(request.user), sceneId))
}

export default async function arFeedRoutes(app: FastifyInstance) {
  app.get<{ Params: { code: string } }>(
    '/api/ar/markers/by-code/:code',
    { config: { scenePass: { sceneFrom: markerSceneByCode } } }, // `ar: true` comes with Task 5
    async (request, reply) => {
      if (!(await signInIfPresent(request, reply))) return
      const marker = await markerByCode(request.params.code)
      if (!marker) return reply.status(404).send({ error: 'not_found' })
      if (!marker.published && !(await isBuilder(request, marker.sceneId))) return reply.status(404).send({ error: 'not_found' })
      const body: ArMarkerLookup = {
        spaceId: marker.spaceId,
        floorId: marker.floorId,
        markerId: marker.markerId,
        spaceName: marker.spaceName,
        whereText: marker.whereText,
      }
      return reply.send(body)
    },
  )

  app.get<{ Params: { id: string }; Querystring: { since?: string } }>(
    '/api/ar/spaces/:id/feed',
    // Its own per-IP limit (bad tokens included); keep polls out of per-request logs.
    { logLevel: 'warn', config: { rateLimit: false, scenePass: { sceneFrom: fromSpace } } },
    async (request, reply) => {
      const limit = limiter.take(`ip:${request.ip}`, 1, AR_FEED_LIMIT.capacity, AR_FEED_LIMIT.refillPerSec)
      if (!limit.ok) return reply.status(429).send({ error: 'rate_limited', retryAfter: Math.ceil(limit.retryAfterMs / 1000) })
      if (!(await signInIfPresent(request, reply))) return
      const spaceId = request.params.id
      const sceneId = await spaceScene(spaceId)
      if (!sceneId) return reply.status(404).send({ error: 'not_found' })
      const builder = await isBuilder(request, sceneId)

      return longPoll(
        request,
        reply,
        sceneId,
        request.query.since,
        holdMs,
        async () => {
          const snap = await arSpaceSnapshot(spaceId)
          // Re-checked on every read, so unpublishing ends a visitor's hold with a 404.
          if (!snap || (!snap.space.published && !builder)) return null
          const body: ArFeedResponse = { v: AR_FEED.version, version: snap.version, space: snap.space, scene: snap.scene }
          return { version: snap.version, body }
        },
        'not_found',
      )
    },
  )
}
