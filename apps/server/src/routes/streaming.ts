/**
 * Streaming Routes — Provision and manage HLS streaming servers.
 *
 * POST   /api/streaming/provision    — Provision a new streaming server
 * GET    /api/streaming              — List user's streaming servers
 * GET    /api/streaming/:id          — Get streaming server details
 * DELETE /api/streaming/:id          — Terminate a streaming server
 * GET    /api/streaming/:id/sessions — List sessions for a server
 * POST   /api/streaming/webhook      — Status callback from media server (internal)
 */

import { FastifyInstance } from 'fastify'
import { randomBytes } from 'node:crypto'
import { eq, desc } from 'drizzle-orm'
import { db } from '../db/connection.js'
import {
  streamingServers,
  streamingSessions,
} from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'
import { requireFeature } from '../middleware/feature-gate.js'
import { config } from '../config.js'

export default async function streamingRoutes(app: FastifyInstance) {
  // ── Provision ─────────────────────────────────────────────────────────
  app.post(
    '/api/streaming/provision',
    { preHandler: [authenticate, requireFeature('streaming')] },
    async (request, reply) => {
      if (!config.streamingEnabled) {
        return reply.status(403).send({ error: 'Streaming is not enabled on this instance' })
      }

      const body = request.body as {
        name: string
        type?: 'shared' | 'dedicated'
        region?: string
        sceneId?: string
      }

      if (!body.name) {
        return reply.status(400).send({ error: 'Missing required field: name' })
      }

      const streamKey = randomBytes(16).toString('hex')
      const ingestUrl = process.env.RTMP_INGEST_URL || 'rtmp://localhost:1935/live'
      const hlsBaseUrl = process.env.HLS_BASE_URL || 'http://localhost:8000/streams'

      const [server] = await db
        .insert(streamingServers)
        .values({
          ownerId: request.user.id,
          name: body.name,
          type: body.type || 'shared',
          status: 'ready',
          rtmpUrl: `${ingestUrl}/${streamKey}`,
          streamKey,
          hlsPlaylistUrl: `${hlsBaseUrl}/${streamKey}/playlist.m3u8`,
          region: body.region || 'us-east-1',
          sceneId: body.sceneId || null,
        })
        .returning()

      // For dedicated servers, would provision infrastructure here
      // (similar to Hyperfy provisioning). For shared, just return the stream key.

      return reply.status(201).send({
        server,
        instructions: {
          rtmpUrl: server.rtmpUrl,
          streamKey,
          hlsPlaylistUrl: server.hlsPlaylistUrl,
          howTo: 'In OBS/Streamlabs: set Server to the rtmpUrl (without stream key), set Stream Key to the streamKey value.',
        },
      })
    },
  )

  // ── List User's Servers ───────────────────────────────────────────────
  app.get(
    '/api/streaming',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const servers = await db
        .select()
        .from(streamingServers)
        .where(eq(streamingServers.ownerId, request.user.id))
        .orderBy(desc(streamingServers.createdAt))

      return reply.send({ servers })
    },
  )

  // ── Get Server Details ────────────────────────────────────────────────
  app.get(
    '/api/streaming/:id',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      const server = await db.query.streamingServers.findFirst({
        where: eq(streamingServers.id, id),
      })

      if (!server) {
        return reply.status(404).send({ error: 'Streaming server not found' })
      }

      return reply.send({ server })
    },
  )

  // ── Terminate Server ──────────────────────────────────────────────────
  app.delete(
    '/api/streaming/:id',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      const server = await db.query.streamingServers.findFirst({
        where: eq(streamingServers.id, id),
      })

      if (!server) {
        return reply.status(404).send({ error: 'Streaming server not found' })
      }

      if (server.ownerId !== request.user.id && request.user.role !== 'admin') {
        return reply.status(403).send({ error: 'Forbidden' })
      }

      // TODO: For dedicated servers, destroy infrastructure

      await db
        .update(streamingServers)
        .set({ status: 'terminated' })
        .where(eq(streamingServers.id, id))

      return reply.send({ terminated: true })
    },
  )

  // ── List Sessions ─────────────────────────────────────────────────────
  app.get(
    '/api/streaming/:id/sessions',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      const sessions = await db
        .select()
        .from(streamingSessions)
        .where(eq(streamingSessions.serverId, id))
        .orderBy(desc(streamingSessions.startedAt))
        .limit(50)

      return reply.send({ sessions })
    },
  )

  // ── Webhook (from media server) ───────────────────────────────────────
  // Not authenticated via JWT — uses shared webhook key instead
  app.post('/api/streaming/webhook', async (request, reply) => {
    // Verify webhook key if configured
    const webhookKey = process.env.STREAMING_WEBHOOK_KEY
    if (webhookKey) {
      const provided = (request.headers as any)['x-webhook-key']
      if (provided !== webhookKey) {
        return reply.status(401).send({ error: 'Invalid webhook key' })
      }
    }

    const body = request.body as {
      streamKey: string
      status: 'live' | 'offline'
      hlsUrl?: string | null
      timestamp?: number
    }

    if (!body.streamKey || !body.status) {
      return reply.status(400).send({ error: 'Missing streamKey or status' })
    }

    // Find the streaming server by stream key
    const [server] = await db
      .select()
      .from(streamingServers)
      .where(eq(streamingServers.streamKey, body.streamKey))
      .limit(1)

    if (!server) {
      return reply.status(404).send({ error: 'Unknown stream key' })
    }

    if (body.status === 'live') {
      // Update server status
      await db
        .update(streamingServers)
        .set({
          status: 'live',
          hlsPlaylistUrl: body.hlsUrl || server.hlsPlaylistUrl,
        })
        .where(eq(streamingServers.id, server.id))

      // Create a new session record
      await db.insert(streamingSessions).values({
        serverId: server.id,
      })

      // If linked to a scene, broadcast video status to the Colyseus room
      // This triggers the scene's video elements to show the live stream
      if (server.sceneId) {
        const { dispatchPlatformCallbacks } = await import('../integrations/platform-hooks.js')
        dispatchPlatformCallbacks(server.sceneId, {
          action: 'video_status',
          isLive: true,
          url: body.hlsUrl || server.hlsPlaylistUrl,
          streamKey: body.streamKey,
        }).catch(() => {})
      }
    } else {
      // Stream went offline
      await db
        .update(streamingServers)
        .set({ status: 'offline' })
        .where(eq(streamingServers.id, server.id))

      // End the current session
      const [session] = await db
        .select()
        .from(streamingSessions)
        .where(eq(streamingSessions.serverId, server.id))
        .orderBy(desc(streamingSessions.startedAt))
        .limit(1)

      if (session && !session.endedAt) {
        const duration = Math.floor(
          (Date.now() - session.startedAt.getTime()) / 1000,
        )
        await db
          .update(streamingSessions)
          .set({ endedAt: new Date(), durationSeconds: duration })
          .where(eq(streamingSessions.id, session.id))
      }

      // Notify scene that stream is offline
      if (server.sceneId) {
        const { dispatchPlatformCallbacks } = await import('../integrations/platform-hooks.js')
        dispatchPlatformCallbacks(server.sceneId, {
          action: 'video_status',
          isLive: false,
          streamKey: body.streamKey,
        }).catch(() => {})
      }
    }

    return reply.send({ ok: true })
  })
}
