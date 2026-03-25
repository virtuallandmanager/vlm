import type { FastifyInstance } from 'fastify'
import { eq, and, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import {
  scenes,
  scenePresets,
  sceneElements,
  sceneElementInstances,
  sceneCollaborators,
  sceneState,
  users,
} from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'
import { config } from '../config.js'
import { getSubscription } from '../integrations/stripe.js'

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

    // Enforce scene limit based on subscription tier (skip in self-hosted mode)
    if (!config.allFeaturesUnlocked) {
      const sub = await getSubscription(request.user.id)
      const limit = sub.limits.scenes

      const [{ count }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(scenes)
        .where(eq(scenes.ownerId, request.user.id))

      if (count >= limit) {
        return reply.status(403).send({
          error: 'scene_limit_reached',
          message: `Your ${sub.tier} plan allows up to ${limit} scenes. Please upgrade to create more.`,
          currentUsage: count,
          limit,
          tier: sub.tier,
        })
      }
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

  // ── GET /api/scenes/:sceneId/collaborators — list collaborators ────────

  app.get<{ Params: { sceneId: string } }>(
    '/api/scenes/:sceneId/collaborators',
    async (request, reply) => {
      const { sceneId } = request.params

      const scene = await db.query.scenes.findFirst({ where: eq(scenes.id, sceneId) })
      if (!scene) return reply.status(404).send({ error: 'Scene not found' })

      const isOwner = scene.ownerId === request.user.id

      // Check if the requesting user is a collaborator
      if (!isOwner && request.user.role !== 'admin') {
        const collab = await db.query.sceneCollaborators.findFirst({
          where: and(
            eq(sceneCollaborators.sceneId, sceneId),
            eq(sceneCollaborators.userId, request.user.id),
          ),
        })
        if (!collab) return reply.status(403).send({ error: 'Forbidden' })
      }

      // Fetch collaborators with user info
      const collabs = await db
        .select({
          userId: sceneCollaborators.userId,
          role: sceneCollaborators.role,
          displayName: users.displayName,
          email: users.email,
        })
        .from(sceneCollaborators)
        .innerJoin(users, eq(sceneCollaborators.userId, users.id))
        .where(eq(sceneCollaborators.sceneId, sceneId))

      // Also include the owner
      const owner = await db.query.users.findFirst({ where: eq(users.id, scene.ownerId) })
      const collaborators = [
        ...(owner
          ? [{ userId: owner.id, role: 'owner' as const, displayName: owner.displayName, email: owner.email }]
          : []),
        ...collabs,
      ]

      return reply.send({ collaborators })
    },
  )

  // ── POST /api/scenes/:sceneId/collaborators — add collaborator ─────────

  app.post<{ Params: { sceneId: string }; Body: { email: string; role: string } }>(
    '/api/scenes/:sceneId/collaborators',
    async (request, reply) => {
      const { sceneId } = request.params
      const { email, role } = request.body

      if (!email || !role) {
        return reply.status(400).send({ error: 'email and role are required' })
      }
      if (role !== 'editor' && role !== 'viewer') {
        return reply.status(400).send({ error: 'role must be editor or viewer' })
      }

      const scene = await db.query.scenes.findFirst({ where: eq(scenes.id, sceneId) })
      if (!scene) return reply.status(404).send({ error: 'Scene not found' })

      // Only owner can add collaborators
      if (scene.ownerId !== request.user.id && request.user.role !== 'admin') {
        return reply.status(403).send({ error: 'Only the scene owner can add collaborators' })
      }

      // Look up user by email
      const targetUser = await db.query.users.findFirst({ where: eq(users.email, email) })
      if (!targetUser) {
        return reply.status(404).send({ error: 'User not found with that email' })
      }

      // Cannot add the owner as a collaborator
      if (targetUser.id === scene.ownerId) {
        return reply.status(409).send({ error: 'That user is already the scene owner' })
      }

      // Check if already a collaborator
      const existing = await db.query.sceneCollaborators.findFirst({
        where: and(
          eq(sceneCollaborators.sceneId, sceneId),
          eq(sceneCollaborators.userId, targetUser.id),
        ),
      })
      if (existing) {
        return reply.status(409).send({ error: 'User is already a collaborator' })
      }

      const [collab] = await db
        .insert(sceneCollaborators)
        .values({
          sceneId,
          userId: targetUser.id,
          role: role as 'editor' | 'viewer',
        })
        .returning()

      return reply.status(201).send({
        collaborator: {
          userId: targetUser.id,
          role: collab.role,
          displayName: targetUser.displayName,
          email: targetUser.email,
        },
      })
    },
  )

  // ── PUT /api/scenes/:sceneId/collaborators/:userId — update role ───────

  app.put<{ Params: { sceneId: string; userId: string }; Body: { role: string } }>(
    '/api/scenes/:sceneId/collaborators/:userId',
    async (request, reply) => {
      const { sceneId, userId } = request.params
      const { role } = request.body

      if (!role || (role !== 'editor' && role !== 'viewer')) {
        return reply.status(400).send({ error: 'role must be editor or viewer' })
      }

      const scene = await db.query.scenes.findFirst({ where: eq(scenes.id, sceneId) })
      if (!scene) return reply.status(404).send({ error: 'Scene not found' })

      // Only owner can change roles
      if (scene.ownerId !== request.user.id && request.user.role !== 'admin') {
        return reply.status(403).send({ error: 'Only the scene owner can change roles' })
      }

      const existing = await db.query.sceneCollaborators.findFirst({
        where: and(
          eq(sceneCollaborators.sceneId, sceneId),
          eq(sceneCollaborators.userId, userId),
        ),
      })
      if (!existing) {
        return reply.status(404).send({ error: 'Collaborator not found' })
      }

      const [updated] = await db
        .update(sceneCollaborators)
        .set({ role: role as 'editor' | 'viewer' })
        .where(
          and(
            eq(sceneCollaborators.sceneId, sceneId),
            eq(sceneCollaborators.userId, userId),
          ),
        )
        .returning()

      return reply.send({ collaborator: updated })
    },
  )

  // ── DELETE /api/scenes/:sceneId/collaborators/:userId — remove ─────────

  app.delete<{ Params: { sceneId: string; userId: string } }>(
    '/api/scenes/:sceneId/collaborators/:userId',
    async (request, reply) => {
      const { sceneId, userId } = request.params

      const scene = await db.query.scenes.findFirst({ where: eq(scenes.id, sceneId) })
      if (!scene) return reply.status(404).send({ error: 'Scene not found' })

      const isOwner = scene.ownerId === request.user.id
      const isSelf = userId === request.user.id

      // Owner can remove anyone; collaborators can remove themselves
      if (!isOwner && !isSelf && request.user.role !== 'admin') {
        return reply.status(403).send({ error: 'Forbidden' })
      }

      const existing = await db.query.sceneCollaborators.findFirst({
        where: and(
          eq(sceneCollaborators.sceneId, sceneId),
          eq(sceneCollaborators.userId, userId),
        ),
      })
      if (!existing) {
        return reply.status(404).send({ error: 'Collaborator not found' })
      }

      await db
        .delete(sceneCollaborators)
        .where(
          and(
            eq(sceneCollaborators.sceneId, sceneId),
            eq(sceneCollaborators.userId, userId),
          ),
        )

      return reply.status(204).send()
    },
  )

  // ── GET /api/scenes/:sceneId/state — get all key-value pairs ───────────

  app.get<{ Params: { sceneId: string } }>(
    '/api/scenes/:sceneId/state',
    async (request, reply) => {
      const { sceneId } = request.params

      const rows = await db
        .select({ key: sceneState.key, value: sceneState.value })
        .from(sceneState)
        .where(
          and(
            eq(sceneState.sceneId, sceneId),
            eq(sceneState.userId, request.user.id),
          ),
        )

      const state: Record<string, unknown> = {}
      for (const row of rows) {
        state[row.key] = row.value
      }

      return reply.send({ state })
    },
  )

  // ── PUT /api/scenes/:sceneId/state — set one or more key-value pairs ───

  app.put<{
    Params: { sceneId: string }
    Body: { key?: string; value?: unknown; entries?: Array<{ key: string; value: unknown }> }
  }>(
    '/api/scenes/:sceneId/state',
    async (request, reply) => {
      const { sceneId } = request.params
      const { key, value, entries } = request.body

      // Build the list of entries to upsert
      const toUpsert: Array<{ key: string; value: unknown }> = []

      if (entries && Array.isArray(entries)) {
        for (const entry of entries) {
          if (!entry.key) continue
          toUpsert.push({ key: entry.key, value: entry.value })
        }
      } else if (key) {
        toUpsert.push({ key, value })
      }

      if (toUpsert.length === 0) {
        return reply.status(400).send({ error: 'Provide { key, value } or { entries: [{ key, value }] }' })
      }

      for (const entry of toUpsert) {
        await db
          .insert(sceneState)
          .values({
            sceneId,
            userId: request.user.id,
            key: entry.key,
            value: entry.value as any,
          })
          .onConflictDoUpdate({
            target: [sceneState.sceneId, sceneState.userId, sceneState.key],
            set: { value: entry.value as any },
          })
      }

      return reply.send({ updated: toUpsert.length })
    },
  )

  // ── DELETE /api/scenes/:sceneId/state/:key — delete a specific key ─────

  app.delete<{ Params: { sceneId: string; key: string } }>(
    '/api/scenes/:sceneId/state/:key',
    async (request, reply) => {
      const { sceneId, key } = request.params

      await db
        .delete(sceneState)
        .where(
          and(
            eq(sceneState.sceneId, sceneId),
            eq(sceneState.userId, request.user.id),
            eq(sceneState.key, key),
          ),
        )

      return reply.status(204).send()
    },
  )

  // ── DELETE /api/scenes/:sceneId/state — delete all state for user ──────

  app.delete<{ Params: { sceneId: string } }>(
    '/api/scenes/:sceneId/state',
    async (request, reply) => {
      const { sceneId } = request.params

      await db
        .delete(sceneState)
        .where(
          and(
            eq(sceneState.sceneId, sceneId),
            eq(sceneState.userId, request.user.id),
          ),
        )

      return reply.status(204).send()
    },
  )
}
