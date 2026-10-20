import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { HYPERFY_FEED, checkHyperfyAnalyticsBatch, type HyperfyFeedResponse } from 'vlm-shared'
import { db } from '../db/connection.js'
import { hyperfyWorlds } from '../db/schema.js'
import { findWorldByKey } from '../hyperfy/worlds.js'
import { recordHyperfyBatch } from '../hyperfy/analytics.js'
import { sceneSnapshot } from '../hyperfy/snapshot.js'
import { onSceneTouched } from '../realtime/bus.js'

let holdMs: number = HYPERFY_FEED.holdMs

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
    { logLevel: 'warn', config: { rateLimit: false } }, // world-key auth; keep the key-bearing polls out of per-request logs
    async (request, reply) => {
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

      const first = await answer()
      if (first.done) return send(first)

      // Hold. Resolves once, whichever of touch / timeout / client close comes first.
      return new Promise<void>((resolve) => {
        let finished = false
        let checking = false
        let again = false
        const finish = (fn: () => unknown) => {
          if (finished) return
          finished = true
          clearTimeout(timer)
          unsubscribe()
          request.raw.off('close', onClose)
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
        const unsubscribe = onSceneTouched(sceneId, () => void check())
        const onClose = () => finish(() => undefined)
        request.raw.on('close', onClose)
      })
    },
  )
}
