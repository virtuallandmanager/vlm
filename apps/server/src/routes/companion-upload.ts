/**
 * Companion Upload Routes — Phone-to-world asset upload via short-lived tokens.
 *
 * Authenticated (HUD/dashboard):
 *   POST /api/upload-tokens           — Create a short-lived upload token
 *
 * Token-authenticated (no JWT needed — the code IS the auth):
 *   GET  /api/upload/:code            — Validate token (returns expiry, remaining uploads)
 *   POST /api/upload/:code            — Upload a file using the token
 */

import { FastifyInstance } from 'fastify'
import { randomBytes } from 'node:crypto'
import { eq, and, gt } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { uploadTokens } from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'
import { actorFromClaims } from '../auth/actor.js'
import { getSceneAccess, hasScope } from '../auth/permissions.js'
import { fromBody } from '../auth/scene-from.js'
import { linkToScene, uploadDestination } from '../library/scene-library.js'
import { storeMedia, StoreMediaError } from '../media/store.js'

/** Generate a short alphanumeric code (6 chars, easy to type on mobile). */
function generateCode(): string {
  // Use only lowercase + digits, no ambiguous chars (0/o, 1/l)
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789'
  const bytes = randomBytes(6)
  return Array.from(bytes)
    .map((b) => chars[b % chars.length])
    .join('')
}

/** Integer within [min, max]; fallback when absent or not a number. */
function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

export default async function companionUploadRoutes(app: FastifyInstance) {
  // ── Create Upload Token (authenticated) ───────────────────────────────
  app.post(
    '/api/upload-tokens',
    { preHandler: [authenticate], config: { scenePass: { sceneFrom: fromBody('sceneId') } } },
    async (request, reply) => {
      const body = (request.body ?? {}) as {
        sceneId?: string
        maxUploads?: number
        expiresInMinutes?: number
      }
      if (body.sceneId) {
        const access = await getSceneAccess(actorFromClaims(request.user), body.sceneId).catch(() => null)
        if (!access || !hasScope(access, 'scene.edit')) return reply.status(403).send({ error: 'forbidden' })
      }

      const code = generateCode()
      const expiresInMs = clamp(body.expiresInMinutes, 1, 60, 30) * 60 * 1000
      const expiresAt = new Date(Date.now() + expiresInMs)

      const [token] = await db
        .insert(uploadTokens)
        .values({
          code,
          userId: request.user.id,
          sceneId: body.sceneId || null,
          maxUploads: clamp(body.maxUploads, 1, 50, 10),
          expiresAt,
        })
        .returning()

      const baseUrl = process.env.PUBLIC_URL || 'http://localhost:3010'
      const uploadUrl = `${baseUrl}/u/${code}`

      return reply.status(201).send({
        token: {
          code,
          uploadUrl,
          expiresAt: expiresAt.toISOString(),
          maxUploads: token.maxUploads,
        },
      })
    },
  )

  // ── Validate Token (no auth) ──────────────────────────────────────────
  app.get('/api/upload/:code', async (request, reply) => {
    const { code } = request.params as { code: string }

    const token = await db.query.uploadTokens.findFirst({
      where: and(
        eq(uploadTokens.code, code),
        gt(uploadTokens.expiresAt, new Date()),
      ),
    })

    if (!token) {
      return reply.status(404).send({ error: 'Invalid or expired upload code' })
    }

    if (token.uploadCount >= token.maxUploads) {
      return reply.status(410).send({ error: 'Upload limit reached' })
    }

    return reply.send({
      valid: true,
      remainingUploads: token.maxUploads - token.uploadCount,
      expiresAt: token.expiresAt.toISOString(),
      sceneId: token.sceneId,
    })
  })

  // ── Upload File (token auth) ──────────────────────────────────────────
  app.post('/api/upload/:code', async (request, reply) => {
    const { code } = request.params as { code: string }

    // Validate token
    const token = await db.query.uploadTokens.findFirst({
      where: and(
        eq(uploadTokens.code, code),
        gt(uploadTokens.expiresAt, new Date()),
      ),
    })

    if (!token) {
      return reply.status(404).send({ error: 'Invalid or expired upload code' })
    }

    if (token.uploadCount >= token.maxUploads) {
      return reply.status(410).send({ error: 'Upload limit reached' })
    }

    const body = request.body as {
      filename: string
      contentType: string
      fileData: string // base64
    }

    if (!body.filename || !body.contentType || !body.fileData) {
      return reply.status(400).send({
        error: 'Missing required fields: filename, contentType, fileData',
      })
    }

    let asset
    try {
      asset = await storeMedia(token.userId, { filename: body.filename, contentType: body.contentType, data: Buffer.from(body.fileData, 'base64') })
    } catch (err) {
      if (err instanceof StoreMediaError) return reply.status(err.status).send(err.body)
      throw err
    }

    // Link to the token's scene when its user may upload there (the code is the auth, so re-check the user's access)
    if (token.sceneId) {
      const dest = await uploadDestination(actorFromClaims({ id: token.userId, role: 'user', verified: true, kind: 'account' } as any), token.sceneId)
      if (dest) await linkToScene(token.sceneId, { mediaAssetId: asset.id }, token.userId, dest.bookingId)
    }

    // Increment upload count
    await db
      .update(uploadTokens)
      .set({ uploadCount: token.uploadCount + 1 })
      .where(eq(uploadTokens.id, token.id))

    return reply.status(201).send({
      asset,
      remainingUploads: token.maxUploads - token.uploadCount - 1,
    })
  })
}
