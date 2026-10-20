/**
 * Connect your own Hyperfy world to a scene.
 *
 * POST   /api/hyperfy/worlds               — Connect a world; returns its key once
 * GET    /api/hyperfy/worlds?sceneId=      — List a scene's connected worlds
 * POST   /api/hyperfy/worlds/:id/rotate-key — Replace the key; returns the new one once
 * DELETE /api/hyperfy/worlds/:id           — Disconnect a world
 *
 * Self-run worlds never consult hyperfyHosting() and don't count toward TIER_LIMITS.
 */

import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { asc, eq } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { hyperfyWorlds } from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'
import { requireFeature } from '../middleware/feature-gate.js'
import { actorFromClaims } from '../auth/actor.js'
import { getSceneAccess, isFullAccess } from '../auth/permissions.js'
import { createWorldKey, worldSummary, type HyperfyWorldRow } from '../hyperfy/worlds.js'

// Same depth from src/routes (dev, tests) and dist/routes (Docker): apps/server/<src|dist>/routes -> repo root.
const APP_HYP = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../packages/vlm-hyperfy-app/dist/vlm.hyp')

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_NAME = 100

const hasFullAccess = async (request: FastifyRequest, sceneId: string) =>
  UUID.test(sceneId) && isFullAccess(await getSceneAccess(actorFromClaims(request.user), sceneId))

/** A world the caller has full access to the scene of; null otherwise (callers answer 404). */
async function worldForCaller(request: FastifyRequest, id: string): Promise<HyperfyWorldRow | null> {
  if (!UUID.test(id)) return null
  const [world] = await db.select().from(hyperfyWorlds).where(eq(hyperfyWorlds.id, id))
  if (!world || !(await hasFullAccess(request, world.sceneId))) return null
  return world
}

export default async function hyperfyWorldRoutes(app: FastifyInstance) {
  const preHandler = [authenticate, requireFeature('deployment')]

  // Public: the built VLM app, to drop into a Hyperfy world. Read per request so a rebuilt file is served without a restart.
  app.get('/api/hyperfy/app.hyp', async (request, reply) => {
    let file: Buffer
    try {
      file = await readFile(APP_HYP)
    } catch (err) {
      request.log.error({ err, path: APP_HYP }, 'hyperfy app.hyp is missing; run the vlm-hyperfy-app build')
      return reply.code(503).send({ error: 'app_unavailable' })
    }
    return reply
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Disposition', 'attachment; filename="vlm.hyp"')
      .send(file)
  })

  app.post<{ Body: { sceneId?: string; name?: string } }>('/api/hyperfy/worlds', { preHandler }, async (request, reply) => {
    const sceneId = String(request.body?.sceneId ?? '')
    const name = String(request.body?.name ?? '').trim()
    if (!name || name.length > MAX_NAME) return reply.status(400).send({ error: 'name is required (up to 100 characters)' })
    if (!(await hasFullAccess(request, sceneId))) return reply.status(404).send({ error: 'Scene not found' })

    const key = createWorldKey()
    const [world] = await db
      .insert(hyperfyWorlds)
      .values({ sceneId, ownerId: request.user.id, name, keyHash: key.hash, keyPrefix: key.prefix })
      .returning()
    return reply.status(201).send({ world: worldSummary(world), key: key.raw })
  })

  app.get<{ Querystring: { sceneId?: string } }>('/api/hyperfy/worlds', { preHandler }, async (request, reply) => {
    const sceneId = request.query.sceneId
    if (!sceneId) return reply.status(400).send({ error: 'sceneId is required' })
    if (!(await hasFullAccess(request, sceneId))) return reply.status(404).send({ error: 'Scene not found' })
    const rows = await db.select().from(hyperfyWorlds).where(eq(hyperfyWorlds.sceneId, sceneId)).orderBy(asc(hyperfyWorlds.createdAt))
    return { worlds: rows.map(worldSummary) }
  })

  app.post<{ Params: { id: string } }>('/api/hyperfy/worlds/:id/rotate-key', { preHandler }, async (request, reply) => {
    const found = await worldForCaller(request, request.params.id)
    if (!found) return reply.status(404).send({ error: 'World not found' })
    const key = createWorldKey()
    const [world] = await db
      .update(hyperfyWorlds)
      .set({ keyHash: key.hash, keyPrefix: key.prefix })
      .where(eq(hyperfyWorlds.id, found.id))
      .returning()
    return { world: worldSummary(world), key: key.raw }
  })

  app.delete<{ Params: { id: string } }>('/api/hyperfy/worlds/:id', { preHandler }, async (request, reply) => {
    const found = await worldForCaller(request, request.params.id)
    if (!found) return reply.status(404).send({ error: 'World not found' })
    await db.delete(hyperfyWorlds).where(eq(hyperfyWorlds.id, found.id))
    return { deleted: true }
  })
}
