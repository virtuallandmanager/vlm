import type { FastifyInstance } from 'fastify'
import { ANALYTICS_LIMITS, checkBatch } from 'vlm-shared'
import { hasDclAuthHeaders, verifyDclSignedFetch } from '../middleware/dcl-auth.js'
import { resolveAnalyticsScene } from '../analytics/registry.js'
import { TokenBucketLimiter, checkRequesterLimits, checkSceneLimits } from '../analytics/limiter.js'
import { createCountryLookup, type CountryLookup } from '../analytics/country.js'
import { writeBatch, SessionSceneMismatchError } from '../analytics/writer.js'

let limiter = new TokenBucketLimiter()
let sweepTimer: NodeJS.Timeout | null = null

/** Test hook. */
export function setIngestLimiter(l: TokenBucketLimiter): void {
  limiter = l
}

export default async function ingestRoutes(app: FastifyInstance) {
  const country: CountryLookup = await createCountryLookup()
  if (!sweepTimer) {
    sweepTimer = setInterval(() => limiter.sweep(new Date().toISOString().slice(0, 10)), 60_000)
    sweepTimer.unref()
  }

  app.post(
    '/api/ingest',
    {
      bodyLimit: ANALYTICS_LIMITS.maxBodyBytes,
      logLevel: 'warn', // keep per-request logs (which include the client IP) out of the logs
      config: { rateLimit: false },
    },
    async (request, reply) => {
      const checked = checkBatch(request.body, Date.now())
      if (!checked.ok) return reply.status(400).send({ error: checked.error })
      const { batch } = checked
      try {
        let signer: string | null = null
        const headers = request.headers as Record<string, string | string[] | undefined>
        if (hasDclAuthHeaders(headers)) {
          try {
            signer = (
              await verifyDclSignedFetch(request.method, request.url.split('?')[0], headers)
            ).walletAddress.toLowerCase()
          } catch {
            signer = null
          }
        }
        if (signer && signer !== batch.visitorId.toLowerCase()) {
          return reply.status(400).send({ error: 'signed wallet does not match visitorId' })
        }
        const verified = !!signer

        const requesterLimit = checkRequesterLimits(limiter, {
          requesterKey: signer ? `w:${signer}` : `ip:${request.ip}`,
          verified,
          eventCount: batch.events.length,
        })
        if (!requesterLimit.ok) {
          if (requesterLimit.tooLarge) return reply.status(413).send({ error: 'batch_too_large' })
          return reply
            .status(429)
            .send({
              error: 'rate_limited',
              retryAfter: Math.ceil(requesterLimit.retryAfterMs / 1000),
            })
        }

        const resolved = await resolveAnalyticsScene(batch.scene, signer)
        if (!resolved.ok) {
          return reply
            .status(resolved.status)
            .send(
              resolved.status === 503
                ? { error: resolved.error, retryAfter: 30 }
                : { error: resolved.error },
            )
        }

        const limit = checkSceneLimits(limiter, {
          sceneId: resolved.scene.id,
          isPreview: resolved.scene.isPreview,
          eventCount: batch.events.length,
          posCount: batch.events.filter((e) => e.type === 'pos').length,
          dayKey: new Date().toISOString().slice(0, 10),
        })
        if (!limit.ok) {
          return reply
            .status(429)
            .send({ error: 'rate_limited', retryAfter: Math.ceil(limit.retryAfterMs / 1000) })
        }

        const { accepted } = await writeBatch({
          scene: resolved.scene,
          batch,
          verified,
          signer,
          country: country.lookup(request.ip, headers),
          keepPosProbability: limit.keepPosProbability,
        })
        return reply.send({ ok: true, accepted, notice: resolved.scene.walletVisibility })
      } catch (err) {
        if (err instanceof SessionSceneMismatchError)
          return reply.status(409).send({ error: 'session_scene_mismatch' })
        // Log the error only: the default handler would log the request, including the client IP.
        request.log.error({ err, route: 'ingest' }, 'ingest failed')
        return reply.status(500).send({ error: 'internal_error' })
      }
    },
  )
}
