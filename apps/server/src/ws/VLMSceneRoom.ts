import { createRequire } from 'node:module'
const _require = createRequire(import.meta.url)
const { Room } = _require('colyseus') as any
type Client = any
import { eq } from 'drizzle-orm'
import { db } from '../db/connection'
import {
  scenes,
  scenePresets,
  sceneElements,
  sceneElementInstances,
} from '../db/schema'
import {
  serializePreset,
  serializeSingleElement,
  serializeSingleInstance,
} from '../services/scene-serializer'
import { dispatchPlatformCallbacks } from '../integrations/platform-hooks'

interface JoinOptions {
  sessionToken: string
  sceneId: string
  clientType?: 'host' | 'analytics'
  user?: { id: string; displayName?: string; connectedWallet?: string }
  [key: string]: unknown
}

interface ClientMeta {
  userId: string
  displayName: string
  clientType: 'host' | 'analytics'
  sceneId: string
}

export class VLMSceneRoom extends Room {
  private sceneId: string = ''
  private clientMeta: Map<string, ClientMeta> = new Map()

  onCreate(options: JoinOptions) {
    this.sceneId = options.sceneId || ''
    console.log(`[VLMSceneRoom] Created for scene ${this.sceneId}`)

    // ── Scene Preset Updates (create/update/delete elements) ──────────────
    this.onMessage('scene_preset_update', async (client, message) => {
      console.log(`[VLMSceneRoom] scene_preset_update from ${client.sessionId}`, message.action)

      try {
        // Persist to database based on action
        await this.persistPresetUpdate(message)
      } catch (err) {
        console.error('[VLMSceneRoom] Error persisting preset update:', err)
      }

      // Broadcast to all OTHER clients in the room
      this.broadcast('scene_preset_update', message, { except: client })

      // Push to HTTP callbacks (Second Life, etc.)
      if (this.sceneId) {
        dispatchPlatformCallbacks(this.sceneId, {
          action: 'config_update',
          elementId: message.elementData?.sk || message.elementData?.id || message.id,
          element: message.element,
          ...this.extractCompactPayload(message),
        }).catch(() => {})
      }
    })

    // ── Preset Switching ──────────────────────────────────────────────────
    this.onMessage('scene_change_preset', async (client, message) => {
      console.log(`[VLMSceneRoom] scene_change_preset`, message.presetId || message.id)

      const presetId = message.presetId || message.id
      if (presetId && this.sceneId) {
        try {
          await db
            .update(scenes)
            .set({ activePresetId: presetId, updatedAt: new Date() })
            .where(eq(scenes.id, this.sceneId))

          // Load the new preset with all elements and instances
          const preset = await db.query.scenePresets.findFirst({
            where: eq(scenePresets.id, presetId),
            with: { elements: { with: { instances: true } } },
          })

          if (preset) {
            const serialized = serializePreset(preset)
            this.broadcast('scene_change_preset', {
              scenePreset: serialized,
              user: this.getClientMeta(client),
            })

            // Push preset change to HTTP callbacks
            dispatchPlatformCallbacks(this.sceneId, {
              action: 'preset_change',
              presetId,
            }).catch(() => {})
          }
        } catch (err) {
          console.error('[VLMSceneRoom] Error changing preset:', err)
        }
      }
    })

    // ── Scene Settings ────────────────────────────────────────────────────
    this.onMessage('scene_setting_update', (client, message) => {
      this.broadcast('scene_setting_update', message, { except: client })
    })

    // ── Video Status Updates ──────────────────────────────────────────────
    this.onMessage('scene_video_update', (client, message) => {
      this.broadcast('scene_video_status', message, { except: client })

      // Push video status to HTTP callbacks
      if (this.sceneId) {
        dispatchPlatformCallbacks(this.sceneId, {
          action: 'video_status',
          sk: message.sk || message.id,
          isLive: message.isLive ?? message.status,
          url: message.url || message.src,
        }).catch(() => {})
      }
    })

    // ── Sound Locators ────────────────────────────────────────────────────
    this.onMessage('scene_sound_locator', (client, message) => {
      this.broadcast('scene_sound_locator', message, { except: client })
    })

    // ── Session & Analytics ───────────────────────────────────────────────
    this.onMessage('session_start', (client, message) => {
      console.log(`[VLMSceneRoom] session_start from ${client.sessionId}`)
      // Acknowledge with session data
      client.send('session_started', {
        session: message,
        user: this.getClientMeta(client),
      })
    })

    this.onMessage('session_action', (client, message) => {
      // Broadcast action to host clients (dashboard) for live analytics
      const meta = this.getClientMeta(client)
      this.broadcastToHosts('add_session_action', {
        action: message.action,
        metadata: message.metadata,
        pathPoint: message.pathPoint,
        displayName: meta?.displayName || 'Unknown',
        timestamp: Date.now(),
      })
    })

    this.onMessage('session_end', (client, _message) => {
      console.log(`[VLMSceneRoom] session_end from ${client.sessionId}`)
    })

    // ── User Messaging ────────────────────────────────────────────────────
    this.onMessage('user_message', (client, message) => {
      this.broadcast('user_message', { ...message, type: 'inbound' }, { except: client })
    })

    // ── User/Player State ─────────────────────────────────────────────────
    this.onMessage('get_user_state', async (client, message) => {
      // TODO: look up from scene_state table
      client.send('get_user_state', { key: message.id, value: undefined })
    })

    this.onMessage('set_user_state', async (client, message) => {
      // TODO: persist to scene_state table
      client.send('set_user_state', { key: message.id, success: true })
    })

    // ── Giveaway Claims ───────────────────────────────────────────────────
    this.onMessage('giveaway_claim', (client, message) => {
      // TODO: process claim against giveaway system
      client.send('giveaway_claim_response', {
        responseType: 'error',
        reason: 'Giveaways not yet implemented in V2',
        giveawayId: message.giveawayId,
      })
    })

    // ── Player Position ───────────────────────────────────────────────────
    this.onMessage('request_player_position', (client, _message) => {
      this.broadcast('request_player_position', {}, { except: client })
    })

    this.onMessage('send_player_position', (client, message) => {
      this.broadcastToHosts('send_player_position', message)
    })

    // ── Path Tracking ─────────────────────────────────────────────────────
    this.onMessage('path_segments_add', (client, message) => {
      // TODO: persist path segments to analytics_paths table
      client.send('path_segments_added', { added: message.pathSegments?.length || 0 })
    })

    // ── Moderator Actions ─────────────────────────────────────────────────
    this.onMessage('scene_moderator_message', (client, message) => {
      this.broadcast('scene_moderator_message', message, { except: client })
    })

    this.onMessage('scene_moderator_crash', (client, message) => {
      this.broadcast('scene_moderator_crash', message, { except: client })
    })
  }

  async onJoin(client: Client, options: JoinOptions) {
    const clientType = options.clientType || 'analytics'
    const userId = options.user?.id || client.sessionId
    const displayName = options.user?.displayName || 'Guest'

    this.clientMeta.set(client.sessionId, {
      userId,
      displayName,
      clientType,
      sceneId: this.sceneId,
    })

    console.log(`[VLMSceneRoom] ${clientType} joined: ${displayName} (${client.sessionId})`)

    // Notify hosts that someone joined
    if (clientType === 'host') {
      this.broadcast('host_joined', { displayName, connectedWallet: options.user?.connectedWallet })
    }

    // Load the active preset and send init data
    await this.sendInitData(client)
  }

  onLeave(client: Client, consented: boolean) {
    const meta = this.clientMeta.get(client.sessionId)
    console.log(`[VLMSceneRoom] ${meta?.clientType || 'unknown'} left: ${meta?.displayName || client.sessionId}`)

    if (meta?.clientType === 'host') {
      this.broadcast('host_left', { displayName: meta.displayName })
    }

    this.clientMeta.delete(client.sessionId)
  }

  onDispose() {
    console.log(`[VLMSceneRoom] Disposed (scene: ${this.sceneId})`)
    this.clientMeta.clear()
  }

  // ── Internal Helpers ──────────────────────────────────────────────────

  private getClientMeta(client: Client): ClientMeta | undefined {
    return this.clientMeta.get(client.sessionId)
  }

  private broadcastToHosts(type: string, message: unknown) {
    for (const client of this.clients) {
      const meta = this.clientMeta.get(client.sessionId)
      if (meta?.clientType === 'host') {
        client.send(type, message)
      }
    }
  }

  private async sendInitData(client: Client) {
    if (!this.sceneId) return

    try {
      const scene = await db.query.scenes.findFirst({
        where: eq(scenes.id, this.sceneId),
      })

      if (!scene?.activePresetId) {
        console.log(`[VLMSceneRoom] No active preset for scene ${this.sceneId}`)
        return
      }

      const preset = await db.query.scenePresets.findFirst({
        where: eq(scenePresets.id, scene.activePresetId),
        with: {
          elements: {
            with: { instances: true },
          },
        },
      })

      if (!preset) {
        console.log(`[VLMSceneRoom] Active preset not found: ${scene.activePresetId}`)
        return
      }

      const serialized = serializePreset(preset)

      client.send('scene_preset_update', {
        action: 'init',
        scenePreset: serialized,
        sceneSettings: [], // TODO: load scene settings
      })

      console.log(
        `[VLMSceneRoom] Sent init data: ${serialized.videos.length} videos, ` +
          `${serialized.images.length} images, ${serialized.sounds.length} sounds, ` +
          `${serialized.models.length} models`,
      )
    } catch (err) {
      console.error('[VLMSceneRoom] Error loading init data:', err)
    }
  }

  private async persistPresetUpdate(message: any) {
    const { action, element, instance, elementData, instanceData, id } = message

    if (action === 'create' && !instance && elementData) {
      // Create a new element
      const activePresetId = await this.getActivePresetId()
      if (!activePresetId) return

      await db.insert(sceneElements).values({
        id: elementData.sk || elementData.id || undefined,
        presetId: activePresetId,
        type: element || 'custom',
        name: elementData.name || element || 'Untitled',
        enabled: elementData.enabled ?? true,
        customId: elementData.customId || null,
        customRendering: elementData.customRendering ?? false,
        clickEvent: elementData.clickEvent || null,
        properties: this.extractProperties(elementData),
      })
    } else if (action === 'create' && instance && instanceData) {
      // Create a new instance
      const elementId = elementData?.sk || elementData?.id || instanceData.elementId
      if (!elementId) return

      await db.insert(sceneElementInstances).values({
        id: instanceData.sk || instanceData.id || undefined,
        elementId,
        enabled: instanceData.enabled ?? true,
        customId: instanceData.customId || null,
        customRendering: instanceData.customRendering ?? false,
        position: instanceData.position || null,
        rotation: instanceData.rotation || null,
        scale: instanceData.scale || null,
        clickEvent: instanceData.clickEvent || null,
        parentInstanceId: instanceData.parent || null,
        withCollisions: instanceData.withCollisions ?? false,
        properties: this.extractProperties(instanceData),
      })
    } else if (action === 'update' && !instance && (elementData || id)) {
      // Update an element
      const elementId = elementData?.sk || elementData?.id || id
      if (!elementId) return

      const updates: Record<string, unknown> = { updatedAt: new Date() }
      if (elementData) {
        if (elementData.name !== undefined) updates.name = elementData.name
        if (elementData.enabled !== undefined) updates.enabled = elementData.enabled
        if (elementData.customId !== undefined) updates.customId = elementData.customId
        if (elementData.clickEvent !== undefined) updates.clickEvent = elementData.clickEvent
        updates.properties = this.extractProperties(elementData)
      }

      await db.update(sceneElements).set(updates).where(eq(sceneElements.id, elementId))
    } else if (action === 'update' && instance && (instanceData || id)) {
      // Update an instance
      const instanceId = instanceData?.sk || instanceData?.id || id
      if (!instanceId) return

      const updates: Record<string, unknown> = { updatedAt: new Date() }
      if (instanceData) {
        if (instanceData.position !== undefined) updates.position = instanceData.position
        if (instanceData.rotation !== undefined) updates.rotation = instanceData.rotation
        if (instanceData.scale !== undefined) updates.scale = instanceData.scale
        if (instanceData.enabled !== undefined) updates.enabled = instanceData.enabled
        if (instanceData.clickEvent !== undefined) updates.clickEvent = instanceData.clickEvent
        if (instanceData.withCollisions !== undefined) updates.withCollisions = instanceData.withCollisions
      }

      await db
        .update(sceneElementInstances)
        .set(updates)
        .where(eq(sceneElementInstances.id, instanceId))
    } else if (action === 'delete' && !instance) {
      const elementId = elementData?.sk || elementData?.id || id
      if (elementId) {
        await db.delete(sceneElements).where(eq(sceneElements.id, elementId))
      }
    } else if (action === 'delete' && instance) {
      const instanceId = instanceData?.sk || instanceData?.id || id
      if (instanceId) {
        await db.delete(sceneElementInstances).where(eq(sceneElementInstances.id, instanceId))
      }
    }
  }

  /**
   * Extract type-specific properties from an element/instance data object.
   * Known structural fields (sk, name, enabled, position, etc.) are removed.
   * Everything else goes into the properties JSONB column.
   */
  private extractProperties(data: Record<string, unknown>): Record<string, unknown> {
    const structuralKeys = new Set([
      'sk',
      'id',
      'pk',
      'name',
      'enabled',
      'customId',
      'customRendering',
      'clickEvent',
      'instances',
      'instanceIds',
      'position',
      'rotation',
      'scale',
      'parent',
      'withCollisions',
      'elementId',
      'configId',
      'entity',
      'services',
      'defaultClickEvent',
    ])

    const properties: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(data)) {
      if (!structuralKeys.has(key) && value !== undefined) {
        properties[key] = value
      }
    }
    return properties
  }

  /**
   * Extract a compact payload from a preset update message for HTTP callbacks.
   * Strips instance arrays and structural fields, keeps only rendering config.
   */
  private extractCompactPayload(message: any): Record<string, unknown> {
    const data = message.elementData || {}
    const result: Record<string, unknown> = { action: message.action }
    // Include type-specific rendering properties
    const props = data as Record<string, unknown>
    for (const [key, value] of Object.entries(props)) {
      if (
        value !== undefined &&
        !['sk', 'id', 'pk', 'instances', 'instanceIds', 'services', 'entity'].includes(key)
      ) {
        result[key] = value
      }
    }
    return result
  }

  private async getActivePresetId(): Promise<string | null> {
    if (!this.sceneId) return null
    const scene = await db.query.scenes.findFirst({
      where: eq(scenes.id, this.sceneId),
    })
    return scene?.activePresetId || null
  }
}
