import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { HYPERFY_FEED, checkHyperfyAnalyticsBatch, type HyperfyFeedResponse } from 'vlm-shared'
import { db } from '../db/connection.js'
import { hyperfyWorlds } from '../db/schema.js'
import { findWorldByKey } from '../hyperfy/worlds.js'
import { recordHyperfyBatch } from '../hyperfy/analytics.js'
import { sceneSnapshot } from '../hyperfy/snapshot.js'
import { onSceneTouched } from '../realtime/bus.js'
import { TokenBucketLimiter } from '../analytics/limiter.js'

let holdMs: number = HYPERFY_FEED.holdMs

// Per IP, checked before the key: a world polls about 3 times a minute, plus bursts on edits and errors.
export const FEED_LIMIT = { capacity: 120, refillPerSec: 2 }
let limiter = new TokenBucketLimiter()

/** Test hook. */
export function setFeedLimiter(l: TokenBucketLimiter): void {
  limiter = l
}

/** Test hook. */
export function setFeedHoldMs(ms: number): void {
  holdMs = ms
}

export default async function hyperfyFeedRoutes(app: FastifyInstance) {
  app.post(
    '/api/hyperfy/analytics',
    { logLevel: 'warn' }, // world-key auth; default rate limit stays
    async (request, reply) => {
      const auth = request.headers.authorization
      const world = auth?.startsWith('Bearer ') ? await findWorldByKey(auth.slice(7)) : null
      if (!world) return reply.status(401).send({ error: 'invalid_world_key' })
      const checked = checkHyperfyAnalyticsBatch(request.body, Date.now())
      if (!checked.ok) return reply.status(400).send({ error: checked.error })
      return reply.send(await recordHyperfyBatch(world, checked.batch))
    },
  )

  app.get<{ Querystring: { since?: string } }>(
    '/api/hyperfy/feed',
    // World-key auth with its own per-IP limit (bad keys included); keep the key-bearing polls out of per-request logs.
    { logLevel: 'warn', config: { rateLimit: false } },
    async (request, reply) => {
      const limit = limiter.take(`ip:${request.ip}`, 1, FEED_LIMIT.capacity, FEED_LIMIT.refillPerSec)
      if (!limit.ok) return reply.status(429).send({ error: 'rate_limited', retryAfter: Math.ceil(limit.retryAfterMs / 1000) })
      const auth = request.headers.authorization
      const world = auth?.startsWith('Bearer ') ? await findWorldByKey(auth.slice(7)) : null
      if (!world) return reply.status(401).send({ error: 'invalid_world_key' })

      const now = Date.now()
      if (!world.lastSeenAt || now - world.lastSeenAt.getTime() >= HYPERFY_FEED.lastSeenThrottleMs) {
        await db.update(hyperfyWorlds).set({ lastSeenAt: new Date(now) }).where(eq(hyperfyWorlds.id, world.id))
      }

      const { sceneId } = world
      const since = request.query.since
      const answer = async (): Promise<{ done: boolean; body?: HyperfyFeedResponse }> => {
        const snap = await sceneSnapshot(sceneId)
        if (!snap) return { done: true }
        return { done: !since || snap.version !== since, body: { v: HYPERFY_FEED.version, ...snap } }
      }
      const send = (r: { body?: HyperfyFeedResponse }) =>
        r.body ? reply.send(r.body) : reply.status(404).send({ error: 'scene_not_found' })
      if (!since) return send(await answer())

      // Listen for the client leaving first, then subscribe before the first read, so a touch landing after
      // that read can't be missed.
      let closed = false
      let onClose = () => {
        closed = true
      }
      const closeListener = () => onClose()
      request.raw.on('close', closeListener)
      let onTouch = () => {}
      let unsubscribe: () => Promise<void>
      try {
        unsubscribe = await onSceneTouched(sceneId, () => onTouch())
      } catch (err) {
        request.raw.off('close', closeListener)
        request.log.error(err)
        return reply.status(500).send({ error: 'feed_failed' })
      }
      let touched = false
      onTouch = () => {
        touched = true
      }
      const release = () => {
        request.raw.off('close', closeListener)
        void unsubscribe()
      }

      let first: Awaited<ReturnType<typeof answer>>
      try {
        first = await answer()
      } catch (err) {
        release()
        throw err
      }
      if (first.done || closed) {
        release()
        return closed ? undefined : send(first)
      }

      // Hold. Resolves once, whichever of touch / timeout / client close comes first.
      return new Promise<void>((resolve) => {
        let finished = false
        let checking = false
        let again = false
        const finish = (fn: () => unknown) => {
          if (finished) return
          finished = true
          clearTimeout(timer)
          release()
          Promise.resolve(fn()).finally(resolve)
        }
        const check = async () => {
          // Serialize re-reads; a touch that lands mid-read triggers one more read afterwards.
          if (checking) { again = true; return }
          checking = true
          try {
            do {
              again = false
              const r = await answer()
              if (r.done) return finish(() => send(r))
            } while (again && !finished)
          } catch (err) {
            request.log.error(err)
            finish(() => reply.status(500).send({ error: 'feed_failed' }))
          } finally {
            checking = false
          }
        }
        const timer = setTimeout(() => {
          // Hold expired: answer with the current state (same version unless a touch was missed).
          finish(async () => {
            const r = await answer().catch(() => null)
            if (r) return send(r)
            return reply.status(500).send({ error: 'feed_failed' })
          })
        }, holdMs)
        onTouch = () => void check()
        onClose = () => finish(() => undefined)
        // A touch during the first read may have come after it read the scene: read once more.
        if (touched) void check()
      })
    },
  )
}
