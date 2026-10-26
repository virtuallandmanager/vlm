/**
 * HUDManager — Main entry point for the in-world management HUD.
 *
 * Orchestrates all HUD panels, handles access control, and bridges
 * Colyseus messages to the notification feed and panel updates.
 *
 * Created by vlm-core after session start — only for authorized operators
 * (scene admin+ with a platform that supports screen-space UI).
 */

import type {
  HUDRenderer,
  BudgetLimits,
  VLMStorage,
  WorldStatus,
} from 'vlm-shared'
import { HUDPanelType } from 'vlm-shared'
import type { VLMHttpClient, ColyseusManager } from 'vlm-client'
import { PanelRegistry } from './PanelRegistry.js'
import { AssetBrowserPanel } from './panels/AssetBrowserPanel.js'
import { SceneLayoutPanel } from './panels/SceneLayoutPanel.js'
import { EventControlPanel } from './panels/EventControlPanel.js'
import { StreamControlPanel } from './panels/StreamControlPanel.js'
import { WorldStatusPanel } from './panels/WorldStatusPanel.js'
import { NotificationPanel } from './panels/NotificationPanel.js'

export interface HUDManagerOptions {
  renderer: HUDRenderer
  http: VLMHttpClient
  colyseus: ColyseusManager
  storage: VLMStorage
  budgetLimits: BudgetLimits
}

export class HUDManager {
  private renderer: HUDRenderer
  private registry: PanelRegistry
  private colyseus: ColyseusManager

  // Panel controllers
  readonly assetBrowser: AssetBrowserPanel
  readonly sceneLayout: SceneLayoutPanel
  readonly eventControl: EventControlPanel
  readonly streamControl: StreamControlPanel
  readonly worldStatus: WorldStatusPanel
  readonly notifications: NotificationPanel

  private initialized = false

  constructor(options: HUDManagerOptions) {
    this.renderer = options.renderer
    this.colyseus = options.colyseus
    this.registry = new PanelRegistry()

    // Create panel controllers
    this.assetBrowser = new AssetBrowserPanel(
      options.renderer,
      options.http,
      options.budgetLimits,
    )
    this.sceneLayout = new SceneLayoutPanel(
      options.renderer,
      options.storage,
      options.colyseus,
    )
    this.eventControl = new EventControlPanel(
      options.renderer,
      options.colyseus,
    )
    this.streamControl = new StreamControlPanel(
      options.renderer,
      options.colyseus,
    )
    this.worldStatus = new WorldStatusPanel(
      options.renderer,
      options.colyseus,
    )
    this.notifications = new NotificationPanel(options.renderer)
  }

  /**
   * Initialize the HUD — register Colyseus message handlers for live updates.
   */
  init(): void {
    if (this.initialized) return
    this.initialized = true

    // Listen for command center status updates → world status panel
    this.colyseus.onMessage('command_center_status', (message: unknown) => {
      const msg = message as { worlds?: WorldStatus[] }
      if (msg.worlds) {
        this.worldStatus.update(msg.worlds)
      }
    })

    // Listen for video status → stream control + notification
    this.colyseus.onMessage('scene_video_status', (message: unknown) => {
      const msg = message as { sk?: string; isLive?: boolean }
      if (msg.sk !== undefined) {
        this.streamControl.updateStreamInfo(msg.sk, { isLive: msg.isLive ?? false })
        this.notifications.push({
          type: msg.isLive ? 'stream_live' : 'stream_offline',
          title: msg.isLive ? 'Stream is live' : 'Stream went offline',
        })
      }
    })

    // Listen for host join/leave → notifications
    this.colyseus.onMessage('host_joined', (message: unknown) => {
      const msg = message as { displayName?: string }
      this.notifications.push({
        type: 'visitor_enter',
        title: `${msg.displayName || 'Someone'} joined as host`,
      })
    })

    this.colyseus.onMessage('host_left', (message: unknown) => {
      const msg = message as { displayName?: string }
      this.notifications.push({
        type: 'visitor_leave',
        title: `${msg.displayName || 'Someone'} left`,
      })
    })

    // Listen for HUD state updates from other clients
    this.colyseus.onMessage('hud_state_update', (message: unknown) => {
      const msg = message as { panel?: string; visible?: boolean; state?: Record<string, unknown> }
      if (msg.panel && msg.visible !== undefined) {
        if (msg.visible) {
          this.registry.show(msg.panel as HUDPanelType, msg.state)
          this.renderer.showPanel(msg.panel as HUDPanelType, {
            visible: true,
            data: msg.state,
          })
        } else {
          this.registry.hide(msg.panel as HUDPanelType)
          this.renderer.hidePanel(msg.panel as HUDPanelType)
        }
      }
    })

    console.log('[HUD] Initialized — 6 panels ready')
  }

  /**
   * Toggle a panel by type. Returns true if panel is now visible.
   */
  togglePanel(panel: HUDPanelType): boolean {
    if (!this.renderer.supportsPanel(panel)) {
      console.warn(`[HUD] Panel ${panel} not supported on this platform`)
      return false
    }

    const nowVisible = this.registry.toggle(panel)
    const state = this.registry.getState(panel)

    if (nowVisible) {
      this.renderer.showPanel(panel, state)
      // Trigger panel-specific open logic
      switch (panel) {
        case HUDPanelType.ASSET_BROWSER:
          this.assetBrowser.open()
          break
        case HUDPanelType.SCENE_LAYOUT:
          this.sceneLayout.open()
          break
        case HUDPanelType.NOTIFICATIONS:
          this.notifications.open()
          break
      }
    } else {
      this.renderer.hidePanel(panel)
    }

    // Also hide any panels that were closed by the registry's modal behavior
    this.syncRendererWithRegistry()

    return nowVisible
  }

  /** Close all panels. */
  closeAll(): void {
    this.registry.hideAll()
    for (const panel of Object.values(HUDPanelType)) {
      this.renderer.hidePanel(panel as HUDPanelType)
    }
    this.sceneLayout.deselectEntity()
  }

  /** Check if a panel is currently visible. */
  isPanelVisible(panel: HUDPanelType): boolean {
    return this.registry.isVisible(panel)
  }

  /** Show an upgrade prompt for a gated feature. */
  showUpgrade(feature: string, tier: string): void {
    this.renderer.showUpgradePrompt(feature, tier)
  }

  /** Tear down — clean up resources. */
  destroy(): void {
    this.closeAll()
    this.notifications.clear()
    this.initialized = false
  }

  /**
   * Sync the renderer with the registry — hide panels the registry closed.
   */
  private syncRendererWithRegistry(): void {
    for (const panel of Object.values(HUDPanelType)) {
      const p = panel as HUDPanelType
      if (!this.registry.isVisible(p)) {
        this.renderer.hidePanel(p)
      }
    }
  }
}
