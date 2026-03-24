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
import { db } from '../db/connection'
import { uploadTokens, assetLibraryItems } from '../db/schema'
import { authenticate } from '../middleware/auth'
import { createStorage } from '../storage'

/** Generate a short alphanumeric code (6 chars, easy to type on mobile). */
function generateCode(): string {
  // Use only lowercase + digits, no ambiguous chars (0/o, 1/l)
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789'
  const bytes = randomBytes(6)
  return Array.from(bytes)
    .map((b) => chars[b % chars.length])
    .join('')
}

export default async function companionUploadRoutes(app: FastifyInstance) {
  const storage = createStorage()

  // ── Create Upload Token (authenticated) ───────────────────────────────
  app.post(
    '/api/upload-tokens',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const body = request.body as {
        sceneId?: string
        maxUploads?: number
        expiresInMinutes?: number
      }

      const code = generateCode()
      const expiresInMs = (body.expiresInMinutes || 30) * 60 * 1000
      const expiresAt = new Date(Date.now() + expiresInMs)

      const [token] = await db
        .insert(uploadTokens)
        .values({
          code,
          userId: request.user.id,
          sceneId: body.sceneId || null,
          maxUploads: body.maxUploads || 10,
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
      name?: string
      category?: string
    }

    if (!body.filename || !body.contentType || !body.fileData) {
      return reply.status(400).send({
        error: 'Missing required fields: filename, contentType, fileData',
      })
    }

    const buffer = Buffer.from(body.fileData, 'base64')
    const key = `companion/${token.userId}/${Date.now()}-${body.filename}`
    const publicUrl = await storage.upload(key, buffer, body.contentType)

    // Create asset library entry
    const [asset] = await db
      .insert(assetLibraryItems)
      .values({
        name: body.name || body.filename,
        category: body.category || null,
        storageKey: key,
        cdnUrl: publicUrl,
        fileSizeBytes: buffer.length,
        isPublic: false, // personal upload
        uploadedBy: token.userId,
      })
      .returning()

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
