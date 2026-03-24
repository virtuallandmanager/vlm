/**
 * VLMCommandCenterRoom — Colyseus room for multi-world event orchestration.
 *
 * Clients join filtered by eventId (or userId for global view).
 * The room aggregates status from all scene rooms linked to the event
 * and broadcasts command_center_status updates periodically.
 *
 * Also handles cross_world_update messages that fan out preset/video changes
 * to all scenes linked to an event.
 */

import { createRequire } from 'node:module'
const _require = createRequire(import.meta.url)
const { Room } = _require('colyseus') as any
type Client = any
import { eq } from 'drizzle-orm'
import { db } from '../db/connection'
import {
  events,
  eventSceneLinks,
  scenes,
  sceneDeployments,
} from '../db/schema'
import { dispatchPlatformCallbacks } from '../integrations/platform-hooks'

interface JoinOptions {
  sessionToken: string
  eventId?: string
  userId?: string
  [key: string]: unknown
}

interface WorldStatus {
  sceneId: string
  sceneName: string
  platform: string | null
  deploymentStatus: string | null
  visitorCount: number
  activePreset: string | null
}

export class VLMCommandCenterRoom extends Room {
  private eventId: string = ''
  private userId: string = ''
  private statusInterval: ReturnType<typeof setInterval> | null = null

  onCreate(options: JoinOptions) {
    this.eventId = options.eventId || ''
    console.log(`[VLMCommandCenter] Created for event ${this.eventId || 'global'}`)

    // ── Cross-World Update ─────────────────────────────────────────────
    // Receives an action and fans it out to all scene rooms linked to this event
    this.onMessage('cross_world_update', async (client, message) => {
      console.log(`[VLMCommandCenter] cross_world_update from ${client.sessionId}`)

      if (!this.eventId) {
        client.send('error', { message: 'No event context for cross-world update' })
        return
      }

      try {
        // Get all scenes linked to this event
        const links = await db
          .select({ sceneId: eventSceneLinks.sceneId })
          .from(eventSceneLinks)
          .where(eq(eventSceneLinks.eventId, this.eventId))

        const sceneIds = links.map((l) => l.sceneId)
        const action = message.action || message.data

        // Fan out to HTTP callbacks for each scene
        // (WebSocket-connected scenes receive updates through their own rooms;
        //  this handles non-WS platforms like Second Life)
        for (const sceneId of sceneIds) {
          dispatchPlatformCallbacks(sceneId, {
            action: 'cross_world_update',
            eventId: this.eventId,
            ...action,
          }).catch(() => {})
        }

        // Broadcast confirmation back to all command center clients
        this.broadcast('cross_world_dispatched', {
          eventId: this.eventId,
          targetScenes: sceneIds,
          action,
        })
      } catch (err) {
        console.error('[VLMCommandCenter] Error dispatching cross-world update:', err)
        client.send('error', { message: 'Failed to dispatch cross-world update' })
      }
    })

    // ── Start periodic status broadcasts ───────────────────────────────
    this.statusInterval = setInterval(() => {
      this.broadcastStatus()
    }, 5000) // Every 5 seconds
  }

  async onJoin(client: Client, options: JoinOptions) {
    this.userId = options.userId || client.sessionId
    console.log(`[VLMCommandCenter] Client joined: ${client.sessionId}`)

    // Send initial status immediately
    await this.broadcastStatus()
  }

  onLeave(client: Client) {
    console.log(`[VLMCommandCenter] Client left: ${client.sessionId}`)
  }

  onDispose() {
    if (this.statusInterval) {
      clearInterval(this.statusInterval)
    }
    console.log(`[VLMCommandCenter] Disposed (event: ${this.eventId || 'global'})`)
  }

  /**
   * Gather status from all worlds linked to the event and broadcast.
   */
  private async broadcastStatus() {
    if (this.clients.length === 0) return

    try {
      let worldStatuses: WorldStatus[] = []

      if (this.eventId) {
        // Event-scoped: get scenes linked to this event
        const links = await db
          .select({
            sceneId: scenes.id,
            sceneName: scenes.name,
            activePreset: scenes.activePresetId,
          })
          .from(eventSceneLinks)
          .innerJoin(scenes, eq(eventSceneLinks.sceneId, scenes.id))
          .where(eq(eventSceneLinks.eventId, this.eventId))

        worldStatuses = await Promise.all(
          links.map(async (link) => {
            // Get latest deployment for this scene
            const deployment = await db.query.sceneDeployments.findFirst({
              where: eq(sceneDeployments.sceneId, link.sceneId),
              orderBy: (d, { desc }) => [desc(d.createdAt)],
            })

            return {
              sceneId: link.sceneId,
              sceneName: link.sceneName,
              platform: deployment?.platform || null,
              deploymentStatus: deployment?.status || null,
              visitorCount: 0, // TODO: count from active Colyseus room clients
              activePreset: link.activePreset,
            }
          }),
        )
      }

      const aggregate = {
        totalVisitors: worldStatuses.reduce((sum, w) => sum + w.visitorCount, 0),
        worldCount: worldStatuses.length,
        deployedCount: worldStatuses.filter((w) => w.deploymentStatus === 'deployed').length,
      }

      this.broadcast('command_center_status', {
        eventId: this.eventId || null,
        worlds: worldStatuses,
        aggregate,
        timestamp: Date.now(),
      })
    } catch (err) {
      console.error('[VLMCommandCenter] Error broadcasting status:', err)
    }
  }
}
