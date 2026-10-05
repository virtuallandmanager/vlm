import type { FastifyInstance, FastifyRequest } from 'fastify'
import { eq } from 'drizzle-orm'
import { validateSceneRef, type AnalyticsSceneRef } from 'vlm-shared'
import { db } from '../db/connection.js'
import { scenes } from '../db/schema.js'
import { hasDclAuthHeaders, verifyDclSignedFetch } from '../middleware/dcl-auth.js'
import { resolveAnalyticsScene } from '../analytics/registry.js'
import { DirectoryUnavailableError } from '../analytics/dcl-directory.js'
import { controls, verifiedWalletsOf } from '../analytics/claims.js'
import { TokenBucketLimiter, checkRequesterLimits } from '../analytics/limiter.js'
import { getActiveSetup, releaseIfRedeployed, setUpLocation, SetupError } from '../setup/setups.js'
import { sceneRoleFor } from '../auth/scene-roles.js'
import { config } from '../config.js'

let limiter = new TokenBucketLimiter()
/** Test hook. */
export function setSetupLimiter(l: TokenBucketLimiter): void {
  limiter = l
}

/** Preview realms can be set up only on a non-cloud (local/self-hosted) server — spec §5.1. */
const previewBlocked = (ref: AnalyticsSceneRef) => ref.isPreview && config.mode === 'cloud'

const short = (w: string) => `${w.slice(0, 6)}…${w.slice(-4)}`

async function signer(request: FastifyRequest): Promise<string | null> {
  const headers = request.headers as Record<string, string | string[] | undefined>
  if (!hasDclAuthHeaders(headers)) return null
  try {
    return (await verifyDclSignedFetch(request.method, request.url.split('?')[0], headers)).walletAddress.toLowerCase()
  } catch {
    return null
  }
}

/** Location + (possibly released) active setup for a signed request. Throws DirectoryUnavailableError upstream. */
async function locate(ref: AnalyticsSceneRef, wallet: string) {
  const resolved = await resolveAnalyticsScene(ref, wallet)
  if (!resolved.ok) return { resolved, scene: null, setup: null }
  const scene = resolved.scene
  let setup = await getActiveSetup(scene.id)
  if (setup) setup = await releaseIfRedeployed(setup, scene)
  return { resolved, scene, setup }
}

async function roleOf(sceneId: string, wallet: string): Promise<'host' | 'cohost' | 'editor' | 'viewer' | null> {
  const scene = await db.query.scenes.findFirst({ where: eq(scenes.id, sceneId) })
  if (scene && (await verifiedWalletsOf(scene.ownerId)).includes(wallet)) return 'host'
  // Signed-fetch caller: no user, so match scene roles by wallet only.
  return sceneRoleFor(sceneId, { userId: null, role: 'viewer', wallet, verified: true }, { walletOnly: true })
}

async function hostShort(sceneId: string): Promise<string> {
  const scene = await db.query.scenes.findFirst({ where: eq(scenes.id, sceneId) })
  const w = scene ? (await verifiedWalletsOf(scene.ownerId))[0] : undefined
  return w ? short(w) : 'someone else'
}

/** Signed-fetch routes (no JWT): the in-world HUD asks what to show, and sets the location up. */
export default async function setupRoutes(app: FastifyInstance) {
  app.post<{ Body: { scene?: unknown } }>('/api/setup/status', async (request, reply) => {
    const ref = validateSceneRef(request.body?.scene)
    const wallet = await signer(request)
    if (!ref || !wallet || previewBlocked(ref)) return reply.send({ state: 'none' })
    if (!checkRequesterLimits(limiter, { requesterKey: `w:${wallet}`, verified: true, eventCount: 1 }).ok) {
      return reply.status(429).send({ error: 'rate_limited' })
    }
    try {
      const { resolved, scene, setup } = await locate(ref, wallet)
      if (!scene) return reply.send({ state: !resolved.ok && resolved.status === 503 ? 'unavailable' : 'none' })
      if (setup) {
        const role = await roleOf(setup.vlmSceneId, wallet)
        if (role) return reply.send({ state: 'member', sceneId: setup.vlmSceneId, role })
        return reply.send((await controls(scene, wallet)) ? { state: 'taken', host: await hostShort(setup.vlmSceneId) } : { state: 'none' })
      }
      return reply.send({ state: (await controls(scene, wallet)) ? 'eligible' : 'none' })
    } catch (err) {
      if (err instanceof DirectoryUnavailableError) return reply.send({ state: 'unavailable' })
      throw err
    }
  })

  app.post<{ Body: { scene?: unknown } }>('/api/setup', async (request, reply) => {
    const wallet = await signer(request)
    if (!wallet) return reply.status(401).send({ error: 'signed_request_required' })
    const ref = validateSceneRef(request.body?.scene)
    if (!ref) return reply.status(400).send({ error: 'scene is required' })
    if (previewBlocked(ref)) return reply.status(403).send({ error: 'not_eligible' })
    if (!checkRequesterLimits(limiter, { requesterKey: `w:${wallet}`, verified: true, eventCount: 1 }).ok) {
      return reply.status(429).send({ error: 'rate_limited' })
    }
    let scene: Awaited<ReturnType<typeof locate>>['scene'] = null
    try {
      const located = await locate(ref, wallet)
      const { resolved, setup } = located
      scene = located.scene
      if (!scene) {
        if (resolved.ok) throw new Error('unreachable')
        return reply.status(resolved.status).send(resolved.status === 503 ? { error: 'upstream_unavailable', retryAfter: 30 } : { error: resolved.error })
      }
      if (setup) return reply.status(409).send({ error: 'already_set_up', host: await hostShort(setup.vlmSceneId) })
      if (!(await controls(scene, wallet))) return reply.status(403).send({ error: 'not_eligible' })
      const created = await setUpLocation(scene, wallet)
      return reply.send({ sceneId: created.vlmSceneId })
    } catch (err) {
      if (err instanceof DirectoryUnavailableError) return reply.status(503).send({ error: 'upstream_unavailable', retryAfter: 30 })
      if (err instanceof SetupError) {
        const active = scene ? await getActiveSetup(scene.id) : null
        return reply.status(err.status).send({ error: err.code, host: active ? await hostShort(active.vlmSceneId) : undefined })
      }
      throw err
    }
  })
}
