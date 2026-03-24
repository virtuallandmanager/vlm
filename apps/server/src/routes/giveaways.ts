import type { FastifyInstance } from 'fastify'
import { eq, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { giveaways, giveawayItems, giveawayClaims } from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'

interface CreateGiveawayBody {
  name: string
  enabled?: boolean
  claimLimit?: number
}

interface UpdateGiveawayBody {
  name?: string
  enabled?: boolean
  claimLimit?: number
}

interface CreateItemBody {
  name?: string
  imageUrl?: string
  contractAddress?: string
  tokenId?: string
  metadata?: unknown
}

export default async function giveawayRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  // ── GET /api/giveaways — list user's giveaways ───────────────────────────

  app.get('/api/giveaways', async (request, reply) => {
    const userGiveaways = await db.query.giveaways.findMany({
      where: eq(giveaways.ownerId, request.user.id),
      orderBy: (g, { desc }) => [desc(g.updatedAt)],
    })
    return reply.send({ giveaways: userGiveaways })
  })

  // ── POST /api/giveaways — create giveaway ────────────────────────────────

  app.post<{ Body: CreateGiveawayBody }>('/api/giveaways', async (request, reply) => {
    const { name, enabled, claimLimit } = request.body

    if (!name) {
      return reply.status(400).send({ error: 'name is required' })
    }

    const [giveaway] = await db
      .insert(giveaways)
      .values({
        ownerId: request.user.id,
        name,
        enabled: enabled ?? true,
        claimLimit: claimLimit ?? 1,
      })
      .returning()

    return reply.status(201).send({ giveaway })
  })

  // ── GET /api/giveaways/:giveawayId — get giveaway with items + claim count

  app.get<{ Params: { giveawayId: string } }>(
    '/api/giveaways/:giveawayId',
    async (request, reply) => {
      const { giveawayId } = request.params

      const giveaway = await db.query.giveaways.findFirst({
        where: eq(giveaways.id, giveawayId),
        with: {
          items: true,
        },
      })

      if (!giveaway) return reply.status(404).send({ error: 'Giveaway not found' })
      if (giveaway.ownerId !== request.user.id && request.user.role !== 'admin') {
        return reply.status(403).send({ error: 'Forbidden' })
      }

      // Get claim count
      const [claimResult] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(giveawayClaims)
        .where(eq(giveawayClaims.giveawayId, giveawayId))

      return reply.send({
        giveaway: {
          ...giveaway,
          claimCount: claimResult.count,
        },
      })
    },
  )

  // ── PUT /api/giveaways/:giveawayId — update giveaway ─────────────────────

  app.put<{ Params: { giveawayId: string }; Body: UpdateGiveawayBody }>(
    '/api/giveaways/:giveawayId',
    async (request, reply) => {
      const { giveawayId } = request.params
      const { name, enabled, claimLimit } = request.body

      const giveaway = await db.query.giveaways.findFirst({ where: eq(giveaways.id, giveawayId) })
      if (!giveaway) return reply.status(404).send({ error: 'Giveaway not found' })
      if (giveaway.ownerId !== request.user.id && request.user.role !== 'admin') {
        return reply.status(403).send({ error: 'Forbidden' })
      }

      const updates: Record<string, unknown> = { updatedAt: new Date() }
      if (name !== undefined) updates.name = name
      if (enabled !== undefined) updates.enabled = enabled
      if (claimLimit !== undefined) updates.claimLimit = claimLimit

      const [updated] = await db
        .update(giveaways)
        .set(updates)
        .where(eq(giveaways.id, giveawayId))
        .returning()

      return reply.send({ giveaway: updated })
    },
  )

  // ── POST /api/giveaways/:giveawayId/items — add item ─────────────────────

  app.post<{ Params: { giveawayId: string }; Body: CreateItemBody }>(
    '/api/giveaways/:giveawayId/items',
    async (request, reply) => {
      const { giveawayId } = request.params
      const { name, imageUrl, contractAddress, tokenId, metadata } = request.body

      const giveaway = await db.query.giveaways.findFirst({ where: eq(giveaways.id, giveawayId) })
      if (!giveaway) return reply.status(404).send({ error: 'Giveaway not found' })
      if (giveaway.ownerId !== request.user.id && request.user.role !== 'admin') {
        return reply.status(403).send({ error: 'Forbidden' })
      }

      const [item] = await db
        .insert(giveawayItems)
        .values({
          giveawayId,
          name: name || null,
          imageUrl: imageUrl || null,
          contractAddress: contractAddress || null,
          tokenId: tokenId || null,
          metadata: metadata ?? null,
        })
        .returning()

      return reply.status(201).send({ item })
    },
  )

  // ── DELETE /api/giveaways/:giveawayId/items/:itemId — remove item ────────

  app.delete<{ Params: { giveawayId: string; itemId: string } }>(
    '/api/giveaways/:giveawayId/items/:itemId',
    async (request, reply) => {
      const { giveawayId, itemId } = request.params

      const giveaway = await db.query.giveaways.findFirst({ where: eq(giveaways.id, giveawayId) })
      if (!giveaway) return reply.status(404).send({ error: 'Giveaway not found' })
      if (giveaway.ownerId !== request.user.id && request.user.role !== 'admin') {
        return reply.status(403).send({ error: 'Forbidden' })
      }

      await db.delete(giveawayItems).where(eq(giveawayItems.id, itemId))
      return reply.status(204).send()
    },
  )
}
