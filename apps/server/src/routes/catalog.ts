/**
 * Public catalog routes.
 *
 * GET /api/catalog/packs — every pack that has models, switched on or off (credits: their models may still be in scenes)
 */
import type { FastifyInstance } from 'fastify'
import { listPacks } from '../catalog/packs.js'

export default async function catalogRoutes(app: FastifyInstance) {
  app.get('/api/catalog/packs', async (_request, reply) => {
    return reply.send({ packs: (await listPacks()).filter((p) => p.modelCount > 0) })
  })
}
