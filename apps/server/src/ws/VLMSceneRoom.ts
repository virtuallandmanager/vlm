import { createRequire } from 'node:module'
const _require = createRequire(import.meta.url)
const { Room } = _require('colyseus') as any
type Client = any
import { eq, and } from 'drizzle-orm'
import { db } from '../db/connection.js'
import {
  scenes,
  scenePresets,
  sceneElements,
  sceneElementInstances,
} from '../db/schema.js'
import {
  serializePreset,
  serializeSingleElement,
  serializeSingleInstance,
} from '../services/scene-serializer.js'
import { dispatchPlatformCallbacks } from '../integrations/platform-hooks.js'
import { config } from '../config.js'
import { verifySessionToken } from '../auth/tokens.js'
import { ANONYMOUS, actorFromClaims, type Actor } from '../auth/actor.js'
import { getSceneAccess, isFullAccess, toVenueAccessMessage, type SceneAccess } from '../auth/permissions.js'
import { authorizeSceneMessage, propertiesOf, type GuardResult, type GuardTarget } from './scene-guard.js'
import { venueTopic, STREAMS_TOPIC, type VenueEvent, type StreamStatusEvent } from '../realtime/bus.js'
import { normalizeUrl, withLiveStatus, withLiveVideo } from '../streaming/live-status.js'
import type { VenueAccessMessage } from 'vlm-shared'

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
  private static activeRoomCount = 0

  private sceneId: string = ''
  private clientMeta: Map<string, ClientMeta> = new Map()
  private accessCache: Map<string, { access: SceneAccess; at: number }> = new Map()
  private lastAccess: Map<string, VenueAccessMessage> = new Map()
  private onVenueEventBound = (e: VenueEvent) => this.onVenueEvent(e)
  private onStreamEventBound = (e: StreamStatusEvent) => this.onStreamEvent(e)
  /** Bumped on every venue event; lookups that started under an older generation must not be cached. */
  private accessGeneration = 0
  private static ACCESS_TTL_MS = 10_000
  /** Scene passes only: when the client's pass expires (ms). After that it acts as an anonymous visitor until renewed. */
  private passExpiry: Map<string, number> = new Map()

  async onAuth(_client: Client, options: JoinOptions): Promise<Actor> {
    const claims = verifySessionToken(options?.sessionToken)
    // A scene pass acts as its user only in its own scene; anywhere else it's an anonymous visitor.
    // Compare against the room's own scene (set in onCreate from the creating client's options, which
    // runs before the first onAuth) — never a joining client's options.sceneId, which joinById can fake.
    if (claims?.kind === 'scene' && (!claims.sceneId || claims.sceneId !== this.sceneId)) return ANONYMOUS
    if (claims?.kind === 'scene') this.passExpiry.set(_client.sessionId, ((claims as { exp?: number }).exp ?? 0) * 1000)
    return actorFromClaims(claims)
  }

  onCreate(options: JoinOptions) {
    VLMSceneRoom.activeRoomCount++

    if (VLMSceneRoom.activeRoomCount > config.maxRoomsPerServer) {
      VLMSceneRoom.activeRoomCount--
      throw new Error('Server room limit reached')
    }

    this.sceneId = options.sceneId || ''
    console.log(`[VLMSceneRoom] Created for scene ${this.sceneId} (active rooms: ${VLMSceneRoom.activeRoomCount})`)
    if (this.sceneId) this.presence.subscribe(venueTopic(this.sceneId), this.onVenueEventBound)
    if (this.sceneId) this.presence.subscribe(STREAMS_TOPIC, this.onStreamEventBound)

    // ── Scene pass renewal: a fresh pass for the same user and this scene extends the session ──
    this.onMessage('auth_renew', (client: Client, message: any) => {
      const claims = verifySessionToken(message?.sessionToken)
      const actor = client.auth as Actor
      const ok =
        claims?.kind === 'scene' && claims.sceneId === this.sceneId && !!actor?.userId && claims.id === actor.userId && this.passExpiry.has(client.sessionId)
      if (!ok) {
        client.send('vlm_error', { code: 'auth_renew_refused', messageType: 'auth_renew' })
        return
      }
      this.passExpiry.set(client.sessionId, ((claims as { exp?: number }).exp ?? 0) * 1000)
      this.accessCache.delete(client.sessionId)
      client.send('auth_renew_ack', {})
    })

    // ── Scene Preset Updates (create/update/delete elements) ──────────────
    this.guarded('scene_preset_update', async (client, message, result) => {
      console.log(`[VLMSceneRoom] scene_preset_update from ${client.sessionId}`, message.action)

      await this.persistPresetUpdate(message, result.target)
      client.send('scene_preset_update_ack', { action: message.action, id: message.elementData?.sk || message.id })

      // Edits to a non-active preset (e.g. a booking clone during setup) are not broadcast
      if (!result.broadcast) return

      // Broadcast to all OTHER clients in the room
      this.broadcast('scene_preset_update', message, { except: client })

      // Push to HTTP callbacks (Second Life, etc.)
      if (this.sceneId) {
        dispatchPlatformCallbacks(this.sceneId, {
          action: 'config_update',
          elementId: result.target?.elementId || message.elementData?.sk || message.elementData?.id || message.id,
          element: message.element,
          ...this.extractCompactPayload(message),
        }).catch(() => {})
      }
    })

    // ── Preset Switching ──────────────────────────────────────────────────
    this.guarded('scene_change_preset', async (client, message) => {
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
            const serialized = await withLiveStatus(serializePreset(preset))
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
    this.guarded('scene_setting_update', (client, message) => {
      this.broadcast('scene_setting_update', message, { except: client })
    })

    // ── Video Status Updates ──────────────────────────────────────────────
    this.guarded('scene_video_update', (client, message) => {
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

    // ── User Messaging ────────────────────────────────────────────────────
    this.onMessage('user_message', (client, message) => {
      this.broadcast('user_message', { ...message, type: 'inbound' }, { except: client })
    })

    // ── Moderator Actions ─────────────────────────────────────────────────
    this.guarded('scene_moderator_message', (client, message) => {
      this.broadcast('scene_moderator_message', message, { except: client })
    })

    this.guarded('scene_moderator_crash', (client, message) => {
      this.broadcast('scene_moderator_crash', message, { except: client })
    })
  }

  async onJoin(client: Client, options: JoinOptions) {
    const requested = options.clientType || 'analytics'
    let canHost = false
    try {
      const access = await this.getAccess(client)
      canHost = isFullAccess(access) || access.level === 'editor'
    } catch {
      canHost = false
    }
    const clientType = requested === 'host' && canHost ? 'host' : 'analytics'
    const actor = client.auth as Actor
    const userId = actor.userId || client.sessionId
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

    // Sent after init so existing clients that wait for init are unaffected
    client.send('auth_status', { authenticated: !!actor.userId && actor.verified })
    await this.sendVenueAccess(client)
  }

  onLeave(client: Client, consented: boolean) {
    const meta = this.clientMeta.get(client.sessionId)
    console.log(`[VLMSceneRoom] ${meta?.clientType || 'unknown'} left: ${meta?.displayName || client.sessionId}`)

    if (meta?.clientType === 'host') {
      this.broadcast('host_left', { displayName: meta.displayName })
    }

    this.clientMeta.delete(client.sessionId)
    this.passExpiry.delete(client.sessionId)
    this.accessCache.delete(client.sessionId)
    this.lastAccess.delete(client.sessionId)
  }

  onDispose() {
    VLMSceneRoom.activeRoomCount--
    console.log(`[VLMSceneRoom] Disposed (scene: ${this.sceneId}, active rooms: ${VLMSceneRoom.activeRoomCount})`)
    if (this.sceneId) this.presence.unsubscribe(venueTopic(this.sceneId), this.onVenueEventBound)
    if (this.sceneId) this.presence.unsubscribe(STREAMS_TOPIC, this.onStreamEventBound)
    this.clientMeta.clear()
    this.accessCache.clear()
    this.lastAccess.clear()
  }

  // ── Internal Helpers ──────────────────────────────────────────────────

  private async getAccess(client: Client): Promise<SceneAccess> {
    const passExp = this.passExpiry.get(client.sessionId)
    if (passExp !== undefined && Date.now() >= passExp) return this.lookupAccess(ANONYMOUS)
    const cached = this.accessCache.get(client.sessionId)
    if (cached && Date.now() - cached.at < VLMSceneRoom.ACCESS_TTL_MS) return cached.access
    const generation = this.accessGeneration
    const access = await this.lookupAccess(client.auth as Actor)
    // A venue event during the lookup may have made this result stale: use it once, don't cache it.
    if (generation === this.accessGeneration) this.accessCache.set(client.sessionId, { access, at: Date.now() })
    return access
  }

  /** Uncached access lookup (a seam for tests). */
  protected lookupAccess(actor: Actor): Promise<SceneAccess> {
    return getSceneAccess(actor, this.sceneId)
  }

  /** Register a handler that runs only if the sender is authorized for this message. */
  private guarded(
    type: string,
    handler: (client: Client, message: any, result: Extract<GuardResult, { ok: true }>) => unknown,
  ) {
    this.onMessage(type, async (client: Client, message: any) => {
      try {
        const result = await authorizeSceneMessage(await this.getAccess(client), this.sceneId, type, message)
        if (!result.ok) {
          client.send('vlm_error', { code: result.code, messageType: type })
          return
        }
        await handler(client, message, result)
      } catch (err) {
        console.error(`[VLMSceneRoom] ${type} failed:`, err)
        client.send('vlm_error', { code: 'server_error', messageType: type })
      }
    })
  }

  /** Send the client's current venue access; returns the previous booking access if it was just lost. */
  private async sendVenueAccess(client: Client) {
    const msg = toVenueAccessMessage(await this.getAccess(client))
    const prev = this.lastAccess.get(client.sessionId)
    this.lastAccess.set(client.sessionId, msg)
    if (prev?.bookingId && !msg.bookingId) return prev
    client.send('venue_access', msg)
    return null
  }

  private async onVenueEvent(e: VenueEvent) {
    try {
      if (e.type === 'element_changed') {
        await this.broadcastElementChange(e)
        return
      }
      if (e.type === 'preset_changed') {
        const preset = await db.query.scenePresets.findFirst({
          where: eq(scenePresets.id, e.presetId),
          with: { elements: { with: { instances: true } } },
        })
        if (preset) this.broadcast('scene_change_preset', { scenePreset: await withLiveStatus(serializePreset(preset)), user: null })
        return
      }
      this.accessGeneration++
      this.accessCache.clear()
      for (const client of this.clients) {
        const lost = await this.sendVenueAccess(client)
        if (lost) {
          const reason = e.type === 'booking_ended' && e.bookingId === lost.bookingId ? e.reason : 'revoked'
          client.send('access_revoked', { bookingId: lost.bookingId, reason })
          client.send('venue_access', this.lastAccess.get(client.sessionId))
        }
      }
    } catch (err) {
      console.error('[VLMSceneRoom] venue event failed:', err)
    }
  }

  /** A REST edit landed: push the element's full current state (or its deletion) if it is live here. */
  private async broadcastElementChange(e: Extract<VenueEvent, { type: 'element_changed' }>) {
    if (e.presetId !== (await this.getActivePresetId())) return
    if (e.deleted) {
      this.broadcast('scene_preset_update', { action: 'delete', element: e.elementType, id: e.elementId })
      return
    }
    const element = await db.query.sceneElements.findFirst({
      where: eq(sceneElements.id, e.elementId),
      with: { instances: true },
    })
    // Gone already (deleted after this event) or moved: the later event carries the truth.
    if (!element || element.presetId !== e.presetId) return
    this.broadcast('scene_preset_update', {
      action: 'upsert',
      element: element.type,
      elementData: element.type === 'video' ? await withLiveVideo(serializeSingleElement(element)) : serializeSingleElement(element),
    })
  }

  /** A VLM stream went live/offline: tell clients about each active-preset screen that plays it. */
  private async onStreamEvent(e: StreamStatusEvent) {
    try {
      if (e?.type !== 'stream_status') return
      const presetId = await this.getActivePresetId()
      if (!presetId) return
      const url = normalizeUrl(e.playlistUrl)
      const videos = await db
        .select()
        .from(sceneElements)
        .where(and(eq(sceneElements.presetId, presetId), eq(sceneElements.type, 'video')))
      for (const v of videos) {
        if (normalizeUrl(serializeSingleElement(v).liveSrc) !== url) continue
        this.broadcast('scene_video_status', { elementId: v.id, status: e.live ? 'live' : 'offline', url: e.playlistUrl })
      }
    } catch (err) {
      console.error('[VLMSceneRoom] stream event failed:', err)
    }
  }

  private getClientMeta(client: Client): ClientMeta | undefined {
    return this.clientMeta.get(client.sessionId)
  }

  private async sendInitData(client: Client) {
    if (!this.sceneId) {
      // Always send init even if there's no scene — client needs this to unblock
      client.send('scene_preset_update', {
        action: 'init',
        scenePreset: { videos: [], images: [], sounds: [], models: [], widgets: [], nfts: [], claimPoints: [] },
        sceneSettings: [],
      })
      return
    }

    try {
      const scene = await db.query.scenes.findFirst({
        where: eq(scenes.id, this.sceneId),
      })

      if (!scene?.activePresetId) {
        console.log(`[VLMSceneRoom] No active preset for scene ${this.sceneId}`)
        // Still send init with empty preset so client doesn't hang
        client.send('scene_preset_update', {
          action: 'init',
          scenePreset: { videos: [], images: [], sounds: [], models: [], widgets: [], nfts: [], claimPoints: [] },
          sceneSettings: [],
        })
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
        client.send('scene_preset_update', {
          action: 'init',
          scenePreset: { videos: [], images: [], sounds: [], models: [], widgets: [], nfts: [], claimPoints: [] },
          sceneSettings: [],
        })
        return
      }

      const serialized = await withLiveStatus(serializePreset(preset))

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
      // Send empty init so client doesn't hang
      client.send('scene_preset_update', {
        action: 'init',
        scenePreset: { videos: [], images: [], sounds: [], models: [], widgets: [], nfts: [], claimPoints: [] },
        sceneSettings: [],
      })
    }
  }

  /**
   * Persist a guarded preset update. Existing elements/instances are addressed only by the
   * ids the guard authorized (`target`), never re-derived from the message.
   */
  private async persistPresetUpdate(message: any, target: GuardTarget = {}) {
    const { action, element, instance, elementData, instanceData } = message

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
      const elementId = target.elementId
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
    } else if (action === 'update' && !instance) {
      // Update an element
      const elementId = target.elementId
      if (!elementId) return

      const updates: Record<string, unknown> = { updatedAt: new Date() }
      if (elementData) {
        if (elementData.name !== undefined) updates.name = elementData.name
        if (elementData.enabled !== undefined) updates.enabled = elementData.enabled
        if (elementData.customId !== undefined) updates.customId = elementData.customId
        if (elementData.clickEvent !== undefined) updates.clickEvent = elementData.clickEvent
        const extracted = this.extractProperties(elementData)
        if (Object.keys(extracted).length > 0) {
          const row = await db.query.sceneElements.findFirst({ where: eq(sceneElements.id, elementId) })
          updates.properties = { ...((row?.properties as Record<string, unknown> | null) ?? {}), ...extracted }
        }
      }

      await db.update(sceneElements).set(updates).where(eq(sceneElements.id, elementId))
    } else if (action === 'update' && instance) {
      // Update an instance
      const instanceId = target.instanceId
      if (!instanceId) return

      const updates: Record<string, unknown> = { updatedAt: new Date() }
      if (instanceData) {
        if (instanceData.position !== undefined) updates.position = instanceData.position
        if (instanceData.rotation !== undefined) updates.rotation = instanceData.rotation
        if (instanceData.scale !== undefined) updates.scale = instanceData.scale
        if (instanceData.enabled !== undefined) updates.enabled = instanceData.enabled
        if (instanceData.clickEvent !== undefined) updates.clickEvent = instanceData.clickEvent
        if (instanceData.withCollisions !== undefined) updates.withCollisions = instanceData.withCollisions
        const extracted = this.extractProperties(instanceData)
        if (Object.keys(extracted).length > 0) {
          const row = await db.query.sceneElementInstances.findFirst({ where: eq(sceneElementInstances.id, instanceId) })
          updates.properties = { ...((row?.properties as Record<string, unknown> | null) ?? {}), ...extracted }
        }
      }

      await db
        .update(sceneElementInstances)
        .set(updates)
        .where(eq(sceneElementInstances.id, instanceId))
    } else if (action === 'delete' && !instance) {
      const elementId = target.elementId
      if (elementId) {
        await db.delete(sceneElements).where(eq(sceneElements.id, elementId))
      }
    } else if (action === 'delete' && instance) {
      const instanceId = target.instanceId
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
    return propertiesOf(data)
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
