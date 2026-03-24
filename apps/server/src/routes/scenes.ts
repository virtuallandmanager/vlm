import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { db } from '../db/connection'
import {
  scenes,
  scenePresets,
  sceneElements,
  sceneElementInstances,
} from '../db/schema'
import { authenticate } from '../middleware/auth'

interface CreateSceneBody {
  name: string
  description?: string
}

interface CreateElementBody {
  type: 'image' | 'video' | 'nft' | 'sound' | 'widget' | 'custom'
  name: string
  enabled?: boolean
  customId?: string
  customRendering?: boolean
  clickEvent?: unknown
  properties?: unknown
}

interface CreateInstanceBody {
  enabled?: boolean
  customId?: string
  customRendering?: boolean
  position?: unknown
  rotation?: unknown
  scale?: unknown
  clickEvent?: unknown
  parentInstanceId?: string
  withCollisions?: boolean
  properties?: unknown
}

interface UpdateInstanceBody {
  enabled?: boolean
  customId?: string
  customRendering?: boolean
  position?: unknown
  rotation?: unknown
  scale?: unknown
  clickEvent?: unknown
  parentInstanceId?: string | null
  withCollisions?: boolean
  properties?: unknown
}

export default async function sceneRoutes(app: FastifyInstance) {
  // All scene routes require authentication
  app.addHook('preHandler', authenticate)

  // ── GET /api/scenes — list user's scenes ─────────────────────────────────

  app.get('/api/scenes', async (request, reply) => {
    const userScenes = await db.query.scenes.findMany({
      where: eq(scenes.ownerId, request.user.id),
      orderBy: (scenes, { desc }) => [desc(scenes.updatedAt)],
    })
    return reply.send({ scenes: userScenes })
  })

  // ── POST /api/scenes — create scene ──────────────────────────────────────

  app.post<{ Body: CreateSceneBody }>('/api/scenes', async (request, reply) => {
    const { name, description } = request.body

    if (!name) {
      return reply.status(400).send({ error: 'name is required' })
    }

    const [scene] = await db
      .insert(scenes)
      .values({
        ownerId: request.user.id,
        name,
        description: description || null,
      })
      .returning()

    // Auto-create a default preset
    const [preset] = await db
      .insert(scenePresets)
      .values({
        sceneId: scene.id,
        name: 'Default',
      })
      .returning()

    // Set the active preset
    await db
      .update(scenes)
      .set({ activePresetId: preset.id })
      .where(eq(scenes.id, scene.id))

    return reply.status(201).send({
      scene: { ...scene, activePresetId: preset.id },
      preset,
    })
  })

  // ── GET /api/scenes/:sceneId — get scene with full nested data ───────────

  app.get<{ Params: { sceneId: string } }>('/api/scenes/:sceneId', async (request, reply) => {
    const { sceneId } = request.params

    const scene = await db.query.scenes.findFirst({
      where: eq(scenes.id, sceneId),
      with: {
        presets: {
          with: {
            elements: {
              with: {
                instances: true,
              },
            },
          },
        },
        collaborators: true,
      },
    })

    if (!scene) {
      return reply.status(404).send({ error: 'Scene not found' })
    }

    // Check ownership or collaboration
    const isOwner = scene.ownerId === request.user.id
    const isCollaborator = scene.collaborators.some((c) => c.userId === request.user.id)
    if (!isOwner && !isCollaborator && request.user.role !== 'admin') {
      return reply.status(403).send({ error: 'Forbidden' })
    }

    return reply.send({ scene })
  })

  // ── PUT /api/scenes/:sceneId — update scene ─────────────────────────────

  app.put<{ Params: { sceneId: string }; Body: Partial<CreateSceneBody> & { activePresetId?: string } }>(
    '/api/scenes/:sceneId',
    async (request, reply) => {
      const { sceneId } = request.params
      const { name, description, activePresetId } = request.body

      const scene = await db.query.scenes.findFirst({ where: eq(scenes.id, sceneId) })
      if (!scene) return reply.status(404).send({ error: 'Scene not found' })
      if (scene.ownerId !== request.user.id && request.user.role !== 'admin') {
        return reply.status(403).send({ error: 'Forbidden' })
      }

      const updates: Record<string, unknown> = { updatedAt: new Date() }
      if (name !== undefined) updates.name = name
      if (description !== undefined) updates.description = description
      if (activePresetId !== undefined) updates.activePresetId = activePresetId

      const [updated] = await db.update(scenes).set(updates).where(eq(scenes.id, sceneId)).returning()
      return reply.send({ scene: updated })
    },
  )

  // ── DELETE /api/scenes/:sceneId — delete scene ───────────────────────────

  app.delete<{ Params: { sceneId: string } }>('/api/scenes/:sceneId', async (request, reply) => {
    const { sceneId } = request.params

    const scene = await db.query.scenes.findFirst({ where: eq(scenes.id, sceneId) })
    if (!scene) return reply.status(404).send({ error: 'Scene not found' })
    if (scene.ownerId !== request.user.id && request.user.role !== 'admin') {
      return reply.status(403).send({ error: 'Forbidden' })
    }

    await db.delete(scenes).where(eq(scenes.id, sceneId))
    return reply.status(204).send()
  })

  // ── POST /api/scenes/:sceneId/presets — create preset ────────────────────

  app.post<{ Params: { sceneId: string }; Body: { name: string; locale?: string } }>(
    '/api/scenes/:sceneId/presets',
    async (request, reply) => {
      const { sceneId } = request.params
      const { name, locale } = request.body

      const scene = await db.query.scenes.findFirst({ where: eq(scenes.id, sceneId) })
      if (!scene) return reply.status(404).send({ error: 'Scene not found' })
      if (scene.ownerId !== request.user.id && request.user.role !== 'admin') {
        return reply.status(403).send({ error: 'Forbidden' })
      }

      const [preset] = await db
        .insert(scenePresets)
        .values({ sceneId, name, locale: locale || null })
        .returning()

      return reply.status(201).send({ preset })
    },
  )

  // ── POST /api/presets/:presetId/elements — create element ────────────────

  app.post<{ Params: { presetId: string }; Body: CreateElementBody }>(
    '/api/presets/:presetId/elements',
    async (request, reply) => {
      const { presetId } = request.params
      const { type, name, enabled, customId, customRendering, clickEvent, properties } = request.body

      if (!type || !name) {
        return reply.status(400).send({ error: 'type and name are required' })
      }

      // Verify preset exists and user has access
      const preset = await db.query.scenePresets.findFirst({
        where: eq(scenePresets.id, presetId),
        with: { scene: true },
      })
      if (!preset) return reply.status(404).send({ error: 'Preset not found' })
      if (preset.scene.ownerId !== request.user.id && request.user.role !== 'admin') {
        return reply.status(403).send({ error: 'Forbidden' })
      }

      const [element] = await db
        .insert(sceneElements)
        .values({
          presetId,
          type,
          name,
          enabled: enabled ?? true,
          customId: customId || null,
          customRendering: customRendering ?? false,
          clickEvent: clickEvent ?? null,
          properties: properties ?? null,
        })
        .returning()

      return reply.status(201).send({ element })
    },
  )

  // ── PUT /api/elements/:elementId — update element ────────────────────────

  app.put<{ Params: { elementId: string }; Body: Partial<CreateElementBody> }>(
    '/api/elements/:elementId',
    async (request, reply) => {
      const { elementId } = request.params

      const element = await db.query.sceneElements.findFirst({
        where: eq(sceneElements.id, elementId),
        with: { preset: { with: { scene: true } } },
      })
      if (!element) return reply.status(404).send({ error: 'Element not found' })
      if (element.preset.scene.ownerId !== request.user.id && request.user.role !== 'admin') {
        return reply.status(403).send({ error: 'Forbidden' })
      }

      const updates: Record<string, unknown> = { updatedAt: new Date() }
      for (const key of ['type', 'name', 'enabled', 'customId', 'customRendering', 'clickEvent', 'properties'] as const) {
        if (request.body[key] !== undefined) updates[key] = request.body[key]
      }

      const [updated] = await db
        .update(sceneElements)
        .set(updates)
        .where(eq(sceneElements.id, elementId))
        .returning()

      return reply.send({ element: updated })
    },
  )

  // ── POST /api/elements/:elementId/instances — create instance ────────────

  app.post<{ Params: { elementId: string }; Body: CreateInstanceBody }>(
    '/api/elements/:elementId/instances',
    async (request, reply) => {
      const { elementId } = request.params

      const element = await db.query.sceneElements.findFirst({
        where: eq(sceneElements.id, elementId),
        with: { preset: { with: { scene: true } } },
      })
      if (!element) return reply.status(404).send({ error: 'Element not found' })
      if (element.preset.scene.ownerId !== request.user.id && request.user.role !== 'admin') {
        return reply.status(403).send({ error: 'Forbidden' })
      }

      const {
        enabled,
        customId,
        customRendering,
        position,
        rotation,
        scale,
        clickEvent,
        parentInstanceId,
        withCollisions,
        properties,
      } = request.body

      const [instance] = await db
        .insert(sceneElementInstances)
        .values({
          elementId,
          enabled: enabled ?? true,
          customId: customId || null,
          customRendering: customRendering ?? false,
          position: position ?? null,
          rotation: rotation ?? null,
          scale: scale ?? null,
          clickEvent: clickEvent ?? null,
          parentInstanceId: parentInstanceId || null,
          withCollisions: withCollisions ?? false,
          properties: properties ?? null,
        })
        .returning()

      return reply.status(201).send({ instance })
    },
  )

  // ── PUT /api/instances/:instanceId — update instance ─────────────────────

  app.put<{ Params: { instanceId: string }; Body: UpdateInstanceBody }>(
    '/api/instances/:instanceId',
    async (request, reply) => {
      const { instanceId } = request.params

      const instance = await db.query.sceneElementInstances.findFirst({
        where: eq(sceneElementInstances.id, instanceId),
        with: { element: { with: { preset: { with: { scene: true } } } } },
      })
      if (!instance) return reply.status(404).send({ error: 'Instance not found' })
      if (instance.element.preset.scene.ownerId !== request.user.id && request.user.role !== 'admin') {
        return reply.status(403).send({ error: 'Forbidden' })
      }

      const updates: Record<string, unknown> = { updatedAt: new Date() }
      for (const key of [
        'enabled',
        'customId',
        'customRendering',
        'position',
        'rotation',
        'scale',
        'clickEvent',
        'parentInstanceId',
        'withCollisions',
        'properties',
      ] as const) {
        if (request.body[key] !== undefined) updates[key] = request.body[key]
      }

      const [updated] = await db
        .update(sceneElementInstances)
        .set(updates)
        .where(eq(sceneElementInstances.id, instanceId))
        .returning()

      return reply.send({ instance: updated })
    },
  )

  // ── DELETE /api/instances/:instanceId — delete instance ──────────────────

  app.delete<{ Params: { instanceId: string } }>(
    '/api/instances/:instanceId',
    async (request, reply) => {
      const { instanceId } = request.params

      const instance = await db.query.sceneElementInstances.findFirst({
        where: eq(sceneElementInstances.id, instanceId),
        with: { element: { with: { preset: { with: { scene: true } } } } },
      })
      if (!instance) return reply.status(404).send({ error: 'Instance not found' })
      if (instance.element.preset.scene.ownerId !== request.user.id && request.user.role !== 'admin') {
        return reply.status(403).send({ error: 'Forbidden' })
      }

      await db.delete(sceneElementInstances).where(eq(sceneElementInstances.id, instanceId))
      return reply.status(204).send()
    },
  )
}
