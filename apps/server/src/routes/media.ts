import type { FastifyInstance } from 'fastify'
import { eq, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { mediaAssets } from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'
import { config } from '../config.js'
import { getSubscription } from '../integrations/stripe.js'
import { createStorage } from '../storage/index.js'
import { randomUUID } from 'crypto'

const storage = createStorage()

export default async function mediaRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  // POST /api/media/upload — Upload a file
  // Accepts multipart/form-data with a 'file' field
  // For simplicity in MVP, accept base64-encoded file in JSON body
  app.post<{ Body: { filename: string; contentType: string; data: string } }>(
    '/api/media/upload',
    async (request, reply) => {
      const { filename, contentType, data } = request.body
      if (!filename || !contentType || !data) {
        return reply.status(400).send({ error: 'filename, contentType, and data (base64) are required' })
      }

      const buffer = Buffer.from(data, 'base64')

      // Enforce storage quota based on subscription tier (skip in self-hosted mode)
      if (!config.allFeaturesUnlocked) {
        const sub = await getSubscription(request.user.id)
        const storageLimit = sub.limits.storageBytes

        const [{ usedBytes }] = await db
          .select({ usedBytes: sql<number>`coalesce(sum(${mediaAssets.sizeBytes}), 0)::int` })
          .from(mediaAssets)
          .where(eq(mediaAssets.ownerId, request.user.id))

        if (usedBytes + buffer.length > storageLimit) {
          return reply.status(403).send({
            error: 'storage_limit_reached',
            message: `Your ${sub.tier} plan allows up to ${Math.round(storageLimit / 1024 / 1024)} MB of storage. This upload would exceed your quota.`,
            currentUsageBytes: usedBytes,
            uploadSizeBytes: buffer.length,
            limitBytes: storageLimit,
            tier: sub.tier,
          })
        }
      }

      const ext = filename.split('.').pop() || 'bin'
      const key = `${request.user.id}/${randomUUID()}.${ext}`

      const publicUrl = await storage.upload(key, buffer, contentType)

      const [asset] = await db.insert(mediaAssets).values({
        ownerId: request.user.id,
        filename,
        contentType,
        sizeBytes: buffer.length,
        storageKey: key,
        publicUrl,
      }).returning()

      return reply.status(201).send({ asset })
    },
  )

  // GET /api/media — List user's media assets
  app.get('/api/media', async (request, reply) => {
    const assets = await db.query.mediaAssets.findMany({
      where: eq(mediaAssets.ownerId, request.user.id),
      orderBy: (mediaAssets, { desc }) => [desc(mediaAssets.createdAt)],
    })
    return reply.send({ assets })
  })

  // DELETE /api/media/:assetId — Delete a media asset
  app.delete<{ Params: { assetId: string } }>(
    '/api/media/:assetId',
    async (request, reply) => {
      const { assetId } = request.params
      const asset = await db.query.mediaAssets.findFirst({
        where: eq(mediaAssets.id, assetId),
      })
      if (!asset) return reply.status(404).send({ error: 'Asset not found' })
      if (asset.ownerId !== request.user.id && request.user.role !== 'admin') {
        return reply.status(403).send({ error: 'Forbidden' })
      }

      await storage.delete(asset.storageKey)
      await db.delete(mediaAssets).where(eq(mediaAssets.id, assetId))
      return reply.status(204).send()
    },
  )
}
