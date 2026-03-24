import type { FastifyInstance } from 'fastify'
import { randomBytes, createHash } from 'node:crypto'
import { eq, and } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { apiKeys } from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'

interface CreateKeyBody {
  name: string
  orgId?: string
  scopes?: string[]
  expiresAt?: string // ISO date string
}

interface DeleteKeyParams {
  keyId: string
}

export default async function apiKeyRoutes(app: FastifyInstance) {
  // ── POST /api/keys — Create a new API key ───────────────────────────────

  app.post<{ Body: CreateKeyBody }>(
    '/api/keys',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { name, orgId, scopes, expiresAt } = request.body

      if (!name) {
        return reply.status(400).send({ error: 'name is required' })
      }

      // Generate the raw key: vlm_k1_ + 32 random hex chars
      const randomPart = randomBytes(16).toString('hex') // 32 hex chars
      const rawKey = `vlm_k1_${randomPart}`

      // Hash for storage
      const keyHash = createHash('sha256').update(rawKey).digest('hex')

      // First 8 chars for identification
      const keyPrefix = rawKey.slice(0, 8)

      const [apiKey] = await db
        .insert(apiKeys)
        .values({
          userId: request.user.id,
          orgId: orgId ?? request.user.orgId ?? null,
          name,
          keyHash,
          keyPrefix,
          scopes: scopes ?? null,
          expiresAt: expiresAt ? new Date(expiresAt) : null,
        })
        .returning()

      return reply.status(201).send({
        id: apiKey.id,
        name: apiKey.name,
        key: rawKey, // returned ONCE — not stored
        keyPrefix: apiKey.keyPrefix,
        scopes: apiKey.scopes,
        expiresAt: apiKey.expiresAt,
        createdAt: apiKey.createdAt,
      })
    },
  )

  // ── GET /api/keys — List user's API keys ────────────────────────────────

  app.get(
    '/api/keys',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const keys = await db
        .select({
          id: apiKeys.id,
          name: apiKeys.name,
          keyPrefix: apiKeys.keyPrefix,
          scopes: apiKeys.scopes,
          lastUsedAt: apiKeys.lastUsedAt,
          expiresAt: apiKeys.expiresAt,
          createdAt: apiKeys.createdAt,
        })
        .from(apiKeys)
        .where(eq(apiKeys.userId, request.user.id))

      return reply.send({ keys })
    },
  )

  // ── DELETE /api/keys/:keyId — Delete an API key ─────────────────────────

  app.delete<{ Params: DeleteKeyParams }>(
    '/api/keys/:keyId',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { keyId } = request.params

      const [deleted] = await db
        .delete(apiKeys)
        .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, request.user.id)))
        .returning()

      if (!deleted) {
        return reply.status(404).send({ error: 'API key not found' })
      }

      return reply.send({ message: 'API key deleted' })
    },
  )
}
