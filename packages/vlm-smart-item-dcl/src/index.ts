/**
 * VLM Smart Item for Decentraland SDK 7
 *
 * Drop this into any Decentraland scene to connect it to VLM.
 * Handles VLM initialization, element rendering, HUD activation,
 * and analytics — all configurable via the Creator Hub UI.
 *
 * The smart item now supports a full setup flow:
 * - If sceneId is set: connects directly to that scene
 * - If no sceneId: shows the HUD setup flow (auth → create/pick scene → connect)
 *
 * Usage as a Smart Item:
 *   Drag "VLM Manager" from the asset catalog, set sceneId, deploy.
 *
 * Usage from code:
 *   import { VLMSmartItem } from 'vlm-smart-item-dcl'
 *   const item = new VLMSmartItem()
 *   item.init({ inventory })
 *   item.spawn(entity, { sceneId: 'your-scene-id' }, channel)
 */

import { createVLM } from 'vlm-adapter-dcl'
import type { VLM } from 'vlm-core'
import type { VLMInitConfig } from 'vlm-shared'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VLMSmartItemProps {
  sceneId: string
  serverUrl: string
  showBeacon: boolean
  enableHud: boolean
  enableAnalytics: boolean
  autoConnect: boolean
  env: 'dev' | 'staging' | 'prod'
}

interface IInventory {
  [key: string]: any
}

interface IChannel {
  id: string
  handleAction: (id: string, handler: (opts: { sender: string; [key: string]: any }) => void) => void
  sendActions: (actions: any) => void
  request: <T>(id: string, body?: any) => Promise<T>
  reply: <T>(id: string, handler: (requester: string) => T) => void
}

type Entity = any

// ---------------------------------------------------------------------------
// VLM Smart Item
// ---------------------------------------------------------------------------

export class VLMSmartItem {
  private vlm: VLM | null = null
  private connecting = false
  private connected = false

  /**
   * Called once when the scene starts, before any instances spawn.
   */
  init(_args: { inventory: IInventory }) {
    // No global initialization needed
  }

  /**
   * Called once for each instance of the smart item placed in the scene.
   */
  spawn(host: Entity, props: VLMSmartItemProps, channel: IChannel) {
    const {
      sceneId,
      serverUrl = 'https://vlm.gg',
      showBeacon = false,
      enableHud = true,
      enableAnalytics = true,
      autoConnect = true,
      env = 'prod',
    } = props

    // Hide the beacon model unless explicitly shown
    if (!showBeacon) {
      try {
        const { VisibilityComponent } = require('@dcl/sdk/ecs') as any
        if (VisibilityComponent) {
          VisibilityComponent.createOrReplace(host, { visible: false })
        }
      } catch {
        // If VisibilityComponent isn't available, that's fine
      }
    }

    // Auto-connect on scene load — works with or without sceneId
    if (autoConnect) {
      this.connect(sceneId, serverUrl, env, enableHud, enableAnalytics)
    }

    // Register action handlers for inter-item communication
    channel.handleAction('connect', () => {
      this.connect(sceneId, serverUrl, env, enableHud, enableAnalytics)
    })

    channel.handleAction('disconnect', () => {
      this.disconnect()
    })

    channel.handleAction('toggleHud', () => {
      if (this.vlm?.hud) {
        this.vlm.sendMessage('vlm:hud:toggle')
      }
    })

    channel.handleAction('switchPreset', (opts: any) => {
      const presetId = opts?.presetId || opts?.values?.presetId
      if (presetId && this.vlm) {
        this.vlm.sendMessage('vlm:preset:switch', { presetId })
      }
    })

    channel.handleAction('triggerGiveaway', (opts: any) => {
      const giveawayId = opts?.giveawayId || opts?.values?.giveawayId
      if (giveawayId && this.vlm) {
        this.vlm.sendMessage('vlm:giveaway:trigger', { giveawayId })
      }
    })

    channel.handleAction('sendMessage', (opts: any) => {
      const messageId = opts?.messageId || opts?.values?.messageId
      const data = opts?.data || opts?.values?.data
      if (messageId && this.vlm) {
        let parsed = data
        if (typeof data === 'string') {
          try { parsed = JSON.parse(data) } catch { /* use raw string */ }
        }
        this.vlm.sendMessage(messageId, parsed)
      }
    })

    channel.handleAction('recordAction', (opts: any) => {
      const actionName = opts?.actionName || opts?.values?.actionName
      if (actionName && this.vlm) {
        this.vlm.recordAction(actionName)
      }
    })

    // Reply to state requests from other smart items
    channel.reply<{ connected: boolean; sceneId: string }>('getState', () => ({
      connected: this.connected,
      sceneId: sceneId || this.vlm?.sceneId || '',
    }))

    console.log(`[VLM Smart Item] Ready. Scene: ${sceneId || '(auto-setup)'}, Server: ${serverUrl}, Auto-connect: ${autoConnect}`)
  }

  /**
   * Connect to VLM and initialize all scene elements.
   * If no sceneId is provided, the HUD will guide the user through setup.
   */
  private async connect(
    sceneId: string,
    serverUrl: string,
    env: 'dev' | 'staging' | 'prod',
    enableHud: boolean,
    enableAnalytics: boolean,
  ) {
    if (this.connecting || this.connected) {
      console.log('[VLM Smart Item] Already connected or connecting')
      return
    }

    this.connecting = true
    console.log(`[VLM Smart Item] Connecting to ${serverUrl}...`)

    try {
      const config: Partial<VLMInitConfig> & { enableHud?: boolean } = {
        env,
        enableHud,
        // Only set sceneId if actually provided (empty string = no scene)
        ...(sceneId ? { sceneId } : {}),
        ...(serverUrl && serverUrl !== 'https://vlm.gg' ? {
          apiUrl: serverUrl,
          wssUrl: serverUrl.replace(/^http/, 'ws'),
        } : {}),
      }

      this.vlm = await createVLM(config)
      this.connected = true
      this.connecting = false

      const storage = this.vlm.storage
      const elementCounts = {
        videos: Object.keys(storage.videos.configs).length,
        images: Object.keys(storage.images.configs).length,
        models: Object.keys(storage.models.configs).length,
        sounds: Object.keys(storage.sounds.configs).length,
        widgets: Object.keys(storage.widgets.configs).length,
      }

      console.log(`[VLM Smart Item] Connected! Scene: ${this.vlm.sceneId}, Elements:`, JSON.stringify(elementCounts))

      if (enableAnalytics) {
        this.vlm.recordAction('vlm:smart_item:connected')
      }
    } catch (err) {
      this.connecting = false
      this.connected = false
      console.error('[VLM Smart Item] Failed to connect:', err)
    }
  }

  /**
   * Disconnect from VLM and clean up.
   */
  private async disconnect() {
    if (!this.vlm) return

    try {
      await this.vlm.destroy()
    } catch (err) {
      console.error('[VLM Smart Item] Error during disconnect:', err)
    }

    this.vlm = null
    this.connected = false
    console.log('[VLM Smart Item] Disconnected')
  }

  /**
   * Get the underlying VLM instance (for advanced usage from code).
   */
  getVLM(): VLM | null {
    return this.vlm
  }

  /**
   * Check if currently connected to VLM.
   */
  isConnected(): boolean {
    return this.connected
  }
}

// Default export for Creator Hub's smart item loader
export default new VLMSmartItem()

// Named exports for code-based usage
export { createVLM } from 'vlm-adapter-dcl'
export type { VLM } from 'vlm-core'
export type { VLMInitConfig, VLMStorage } from 'vlm-shared'
