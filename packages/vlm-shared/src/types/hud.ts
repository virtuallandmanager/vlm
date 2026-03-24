/**
 * HUD Types — Interfaces for the in-world management HUD.
 *
 * The HUDRenderer interface is implemented per-platform (DCL UI Toolkit,
 * Hyperfy panels, Three.js HTML). The vlm-hud package contains
 * platform-agnostic logic that calls these methods.
 */

import { EntityHandle } from '../platform.js'
import { HUDPanelType } from '../enums/index.js'
import type { WorldStatus } from '../protocol.js'

// ---------------------------------------------------------------------------
// HUD Renderer — implemented by each platform adapter
// ---------------------------------------------------------------------------

export interface HUDRenderer {
  /** Show a named panel with initial state. */
  showPanel(panel: HUDPanelType, state: HUDPanelState): void

  /** Hide a named panel. */
  hidePanel(panel: HUDPanelType): void

  /** Render a grid of asset thumbnails (for asset browser). */
  renderAssetGrid(assets: AssetThumbnail[]): void

  /** Show a transform gizmo on an entity for move/rotate/scale. */
  showTransformGizmo(entity: EntityHandle, mode: 'move' | 'rotate' | 'scale'): void

  /** Hide the transform gizmo. */
  hideTransformGizmo(): void

  /** Show a notification toast. */
  showNotification(notification: HUDNotification): void

  /** Render the budget meter (file size, triangles, etc.). */
  renderBudgetMeter(usage: BudgetUsage, limits: BudgetLimits): void

  /** Show an upgrade/purchase prompt for a gated feature. */
  showUpgradePrompt(feature: string, tier: string): void

  /** Render the mini command center (world status grid). */
  renderWorldStatusGrid(worlds: WorldStatus[]): void

  /** Can this platform render the given panel type? */
  supportsPanel(panel: HUDPanelType): boolean
}

// ---------------------------------------------------------------------------
// Panel State
// ---------------------------------------------------------------------------

export interface HUDPanelState {
  visible: boolean
  data?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Asset Browser types
// ---------------------------------------------------------------------------

export interface AssetThumbnail {
  id: string
  name: string
  thumbnailUrl: string | null
  cdnUrl: string | null
  category: string | null
  fileSizeBytes: number
  triangleCount: number | null
  tier?: string // null = free, 'creator' | 'pro' | 'studio' for paid
}

// ---------------------------------------------------------------------------
// Budget Meter types
// ---------------------------------------------------------------------------

export interface BudgetUsage {
  fileSizeBytes: number
  triangleCount: number
  textureCount: number
  materialCount: number
  entityCount: number
}

export interface BudgetLimits {
  maxFileSizeBytes: number
  maxTriangleCount: number
  maxTextureCount: number
  maxMaterialCount: number
  maxEntityCount: number
  platformName: string
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export type HUDNotificationType =
  | 'visitor_enter'
  | 'visitor_leave'
  | 'giveaway_claim'
  | 'stream_live'
  | 'stream_offline'
  | 'deploy_complete'
  | 'deploy_failed'
  | 'asset_uploaded'
  | 'info'
  | 'warning'
  | 'error'

export interface HUDNotification {
  id: string
  type: HUDNotificationType
  title: string
  message?: string
  worldId?: string
  timestamp: number
}

// WorldStatus is defined in protocol.ts and re-exported from the package index.
// HUD components should import it from 'vlm-shared' directly.
