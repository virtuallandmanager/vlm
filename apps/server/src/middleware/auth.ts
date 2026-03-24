import type { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify'
import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { apiKeys, users } from '../db/schema.js'

export interface AuthUser {
  id: string
  email: string | null
  role: string
  orgId: string | null
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { id: string; email: string | null; role: string; orgId?: string | null; refresh?: boolean }
    user: AuthUser
  }
}

/**
 * Fastify preHandler that verifies the JWT from the Authorization header
 * and attaches the decoded user to request.user.
 *
 * Also supports API key authentication via `Bearer vlm_...` tokens.
 */
export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  try {
    const authHeader = request.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid or missing token' })
    }

    const token = authHeader.slice(7)

    // ── API Key auth ──────────────────────────────────────────────────────
    if (token.startsWith('vlm_')) {
      const keyHash = createHash('sha256').update(token).digest('hex')

      const [apiKey] = await db
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.keyHash, keyHash))
        .limit(1)

      if (!apiKey) {
        return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid API key' })
      }

      // Check expiry
      if (apiKey.expiresAt && new Date(apiKey.expiresAt) < new Date()) {
        return reply.status(401).send({ error: 'Unauthorized', message: 'API key has expired' })
      }

      // Look up the user
      const user = await db.query.users.findFirst({
        where: eq(users.id, apiKey.userId),
      })

      if (!user) {
        return reply.status(401).send({ error: 'Unauthorized', message: 'API key owner not found' })
      }

      // Update lastUsedAt (fire-and-forget)
      db.update(apiKeys)
        .set({ lastUsedAt: new Date() })
        .where(eq(apiKeys.id, apiKey.id))
        .then(() => {})
        .catch(() => {})

      request.user = {
        id: user.id,
        email: user.email,
        role: user.role,
        orgId: apiKey.orgId ?? user.activeOrgId ?? null,
      }
      return
    }

    // ── JWT auth (default) ────────────────────────────────────────────────
    const decoded = await request.jwtVerify<AuthUser>()
    request.user = decoded
  } catch (err) {
    reply.status(401).send({ error: 'Unauthorized', message: 'Invalid or missing token' })
  }
}

/**
 * Register the JWT plugin on a Fastify instance.
 */
export function registerJwt(app: FastifyInstance, secret: string) {
  return app.register(import('@fastify/jwt'), {
    secret,
    sign: { expiresIn: '15m' },
  })
}
