/**
 * Asset Library Routes — Browse, search, and manage 3D assets.
 *
 * GET    /api/assets            — Browse/search asset catalog
 * GET    /api/assets/:id        — Get single asset details
 * POST   /api/assets            — Upload a new asset (authenticated)
 * PUT    /api/assets/:id        — Update asset metadata (authenticated)
 * DELETE /api/assets/:id        — Delete an asset (authenticated)
 * GET    /api/assets/categories — List all categories
 */

import { FastifyInstance } from 'fastify'
import { eq, ilike, and, or, sql, arrayContains } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { assetLibraryItems } from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'
import { createStorage } from '../storage/index.js'

export default async function assetRoutes(app: FastifyInstance) {
  const storage = createStorage()

  // ── Browse / Search ───────────────────────────────────────────────────
  app.get('/api/assets', async (request, reply) => {
    const query = request.query as {
      q?: string
      category?: string
      tag?: string
      maxTriangles?: string
      maxFileSize?: string
      limit?: string
      offset?: string
    }

    const conditions: any[] = []

    // Only show public assets (or user's own if authenticated)
    conditions.push(eq(assetLibraryItems.isPublic, true))

    if (query.q) {
      conditions.push(
        or(
          ilike(assetLibraryItems.name, `%${query.q}%`),
          ilike(assetLibraryItems.description, `%${query.q}%`),
        ),
      )
    }

    if (query.category) {
      conditions.push(eq(assetLibraryItems.category, query.category))
    }

    if (query.tag) {
      conditions.push(arrayContains(assetLibraryItems.tags, [query.tag]))
    }

    if (query.maxTriangles) {
      conditions.push(
        sql`${assetLibraryItems.triangleCount} <= ${parseInt(query.maxTriangles)}`,
      )
    }

    if (query.maxFileSize) {
      conditions.push(
        sql`${assetLibraryItems.fileSizeBytes} <= ${parseInt(query.maxFileSize)}`,
      )
    }

    const limit = Math.min(parseInt(query.limit || '50'), 100)
    const offset = parseInt(query.offset || '0')

    const items = await db
      .select()
      .from(assetLibraryItems)
      .where(and(...conditions))
      .limit(limit)
      .offset(offset)
      .orderBy(assetLibraryItems.createdAt)

    const [countResult] = await db
      .select({ count: sql<number>`count(*)` })
      .from(assetLibraryItems)
      .where(and(...conditions))

    return reply.send({
      assets: items,
      total: Number(countResult.count),
      limit,
      offset,
    })
  })

  // ── Get Single Asset ──────────────────────────────────────────────────
  app.get('/api/assets/:id', async (request, reply) => {
    const { id } = request.params as { id: string }

    const asset = await db.query.assetLibraryItems.findFirst({
      where: eq(assetLibraryItems.id, id),
    })

    if (!asset) {
      return reply.status(404).send({ error: 'Asset not found' })
    }

    return reply.send({ asset })
  })

  // ── Upload New Asset ──────────────────────────────────────────────────
  app.post(
    '/api/assets',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const body = request.body as {
        name: string
        description?: string
        category?: string
        tags?: string[]
        fileData: string // base64 encoded
        contentType: string
        filename: string
        triangleCount?: number
        textureCount?: number
        materialCount?: number
        dimensions?: { width: number; height: number; depth: number }
        license?: string
        author?: string
        isPublic?: boolean
      }

      if (!body.name || !body.fileData || !body.contentType) {
        return reply.status(400).send({
          error: 'Missing required fields: name, fileData, contentType',
        })
      }

      const buffer = Buffer.from(body.fileData, 'base64')
      const key = `assets/${Date.now()}-${body.filename || 'asset.glb'}`
      const publicUrl = await storage.upload(key, buffer, body.contentType)

      const [asset] = await db
        .insert(assetLibraryItems)
        .values({
          name: body.name,
          description: body.description || null,
          category: body.category || null,
          tags: body.tags || null,
          storageKey: key,
          cdnUrl: publicUrl,
          thumbnailUrl: null, // TODO: generate thumbnail from GLB
          fileSizeBytes: buffer.length,
          triangleCount: body.triangleCount || null,
          textureCount: body.textureCount || null,
          materialCount: body.materialCount || null,
          dimensions: body.dimensions || null,
          license: body.license || null,
          author: body.author || null,
          isPublic: body.isPublic ?? true,
          uploadedBy: request.user.id,
        })
        .returning()

      return reply.status(201).send({ asset })
    },
  )

  // ── Update Asset Metadata ─────────────────────────────────────────────
  app.put(
    '/api/assets/:id',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const body = request.body as Record<string, unknown>

      const existing = await db.query.assetLibraryItems.findFirst({
        where: eq(assetLibraryItems.id, id),
      })

      if (!existing) {
        return reply.status(404).send({ error: 'Asset not found' })
      }

      // Only owner or admin can update
      if (existing.uploadedBy !== request.user.id && request.user.role !== 'admin') {
        return reply.status(403).send({ error: 'Forbidden' })
      }

      const updates: Record<string, unknown> = {}
      if (body.name !== undefined) updates.name = body.name
      if (body.description !== undefined) updates.description = body.description
      if (body.category !== undefined) updates.category = body.category
      if (body.tags !== undefined) updates.tags = body.tags
      if (body.license !== undefined) updates.license = body.license
      if (body.author !== undefined) updates.author = body.author
      if (body.isPublic !== undefined) updates.isPublic = body.isPublic

      const [updated] = await db
        .update(assetLibraryItems)
        .set(updates)
        .where(eq(assetLibraryItems.id, id))
        .returning()

      return reply.send({ asset: updated })
    },
  )

  // ── Delete Asset ──────────────────────────────────────────────────────
  app.delete(
    '/api/assets/:id',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      const existing = await db.query.assetLibraryItems.findFirst({
        where: eq(assetLibraryItems.id, id),
      })

      if (!existing) {
        return reply.status(404).send({ error: 'Asset not found' })
      }

      if (existing.uploadedBy !== request.user.id && request.user.role !== 'admin') {
        return reply.status(403).send({ error: 'Forbidden' })
      }

      await storage.delete(existing.storageKey)
      await db.delete(assetLibraryItems).where(eq(assetLibraryItems.id, id))

      return reply.send({ deleted: true })
    },
  )

  // ── List Categories ───────────────────────────────────────────────────
  app.get('/api/assets/categories', async (_request, reply) => {
    const result = await db
      .select({ category: assetLibraryItems.category })
      .from(assetLibraryItems)
      .where(eq(assetLibraryItems.isPublic, true))
      .groupBy(assetLibraryItems.category)

    const categories = result
      .map((r) => r.category)
      .filter(Boolean)

    return reply.send({ categories })
  })
}
