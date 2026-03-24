/**
 * Platform Hook Routes — HTTP endpoints for non-WebSocket platform integration.
 *
 * POST /hook/register  — Register/re-register a callback URL
 * GET  /hook/config    — Poll config for a single element
 * GET  /hook/scene     — Poll full scene config (all elements)
 *
 * These routes do NOT require JWT auth. Platform scripts authenticate
 * implicitly via sceneId + platform. The data returned is read-only
 * scene config (no mutations possible through these endpoints).
 */

import { FastifyInstance } from 'fastify'
import { eq, and } from 'drizzle-orm'
import { db } from '../db/connection'
import {
  platformCallbacks,
  scenes,
  scenePresets,
  sceneElements,
} from '../db/schema'

export default async function hookRoutes(app: FastifyInstance) {
  // ── POST /hook/register ─────────────────────────────────────────────────
  app.post('/hook/register', async (request, reply) => {
    const body = request.body as {
      sceneId: string
      elementId?: string
      elementType?: string
      callbackUrl: string
      platform: string
      mode?: string
      region?: string
      metadata?: Record<string, unknown>
    }

    if (!body.sceneId || !body.callbackUrl || !body.platform) {
      return reply.status(400).send({
        error: 'Missing required fields: sceneId, callbackUrl, platform',
      })
    }

    const mode = body.mode || 'element'

    // Upsert: match on scene + element + type + platform
    // Check for existing callback
    const existing = await db
      .select()
      .from(platformCallbacks)
      .where(
        and(
          eq(platformCallbacks.sceneId, body.sceneId),
          eq(platformCallbacks.platform, body.platform),
          eq(platformCallbacks.callbackUrl, body.callbackUrl),
        ),
      )
      .limit(1)

    if (existing.length > 0) {
      // Re-register: update timestamp, reset failure count
      await db
        .update(platformCallbacks)
        .set({
          lastRegistered: new Date(),
          failureCount: 0,
          elementId: body.elementId || null,
          elementType: body.elementType || null,
          mode,
          region: body.region || null,
          metadata: body.metadata || null,
        })
        .where(eq(platformCallbacks.id, existing[0].id))
    } else {
      // New registration
      await db.insert(platformCallbacks).values({
        sceneId: body.sceneId,
        elementId: body.elementId || null,
        elementType: body.elementType || null,
        platform: body.platform,
        mode,
        callbackUrl: body.callbackUrl,
        region: body.region || null,
        metadata: body.metadata || null,
      })
    }

    // Return current config so the script can initialize immediately
    if (mode === 'controller') {
      return getSceneConfig(body.sceneId, reply)
    }

    if (body.elementId && body.elementType) {
      return getElementConfig(body.sceneId, body.elementId, body.elementType, reply)
    }

    // If no specific element requested, return scene config
    return getSceneConfig(body.sceneId, reply)
  })

  // ── GET /hook/config ────────────────────────────────────────────────────
  app.get('/hook/config', async (request, reply) => {
    const query = request.query as {
      sceneId?: string
      elementId?: string
      elementType?: string
    }

    if (!query.sceneId || !query.elementId || !query.elementType) {
      return reply.status(400).send({
        error: 'Missing required query params: sceneId, elementId, elementType',
      })
    }

    return getElementConfig(query.sceneId, query.elementId, query.elementType, reply)
  })

  // ── GET /hook/scene ─────────────────────────────────────────────────────
  app.get('/hook/scene', async (request, reply) => {
    const query = request.query as { sceneId?: string }

    if (!query.sceneId) {
      return reply.status(400).send({ error: 'Missing required query param: sceneId' })
    }

    return getSceneConfig(query.sceneId, reply)
  })
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Get compact config for a single element (video or image).
 * Responses are kept small for SL's 16 KB limit.
 */
async function getElementConfig(
  sceneId: string,
  elementId: string,
  elementType: string,
  reply: any,
) {
  const scene = await db.query.scenes.findFirst({
    where: eq(scenes.id, sceneId),
  })

  if (!scene?.activePresetId) {
    return reply.status(404).send({ error: 'Scene not found or no active preset' })
  }

  // Find the element by customId or ID within the active preset
  const elements = await db
    .select()
    .from(sceneElements)
    .where(
      and(
        eq(sceneElements.presetId, scene.activePresetId),
        eq(sceneElements.type, elementType as any),
      ),
    )

  const element = elements.find(
    (e) => e.customId === elementId || e.id === elementId,
  )

  if (!element) {
    return reply.status(404).send({ error: 'Element not found' })
  }

  return reply.send(compactElementConfig(element))
}

/**
 * Get compact scene config (all video and image elements).
 * Strips instances (SL scripts manage their own prim positioning).
 */
async function getSceneConfig(sceneId: string, reply: any) {
  const scene = await db.query.scenes.findFirst({
    where: eq(scenes.id, sceneId),
  })

  if (!scene?.activePresetId) {
    return reply.status(404).send({ error: 'Scene not found or no active preset' })
  }

  const elements = await db
    .select()
    .from(sceneElements)
    .where(eq(sceneElements.presetId, scene.activePresetId))

  const videos = elements
    .filter((e) => e.type === 'video')
    .map(compactElementConfig)

  const images = elements
    .filter((e) => e.type === 'image')
    .map(compactElementConfig)

  return reply.send({ videos, images })
}

/**
 * Flatten an element into a compact config for hook responses.
 * Merges properties to top-level, uses `id` field, keeps only rendering-relevant data.
 */
function compactElementConfig(element: {
  id: string
  type: string
  name: string
  enabled: boolean
  customId: string | null
  properties: unknown
}): Record<string, unknown> {
  const props = (element.properties || {}) as Record<string, unknown>
  return {
    id: element.id,
    customId: element.customId || undefined,
    enabled: element.enabled,
    ...props,
  }
}
