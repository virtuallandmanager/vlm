/**
 * Decentraland HUD Renderer
 *
 * Implements the VLM HUDRenderer interface using DCL SDK 7's ReactECS UI system.
 * Renders management panels as screen-space overlay UI.
 */

import ReactEcs, { ReactEcsRenderer, UiEntity, Label, Input } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import type {
  HUDRenderer,
  HUDPanelState,
  HUDNotification,
  AssetThumbnail,
  BudgetUsage,
  BudgetLimits,
} from 'vlm-shared'
import { HUDPanelType } from 'vlm-shared'
import type { EntityHandle, WorldStatus } from 'vlm-shared'

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface HUDState {
  activePanel: HUDPanelType | null
  panelStates: Map<HUDPanelType, HUDPanelState>
  notifications: HUDNotification[]
  assets: AssetThumbnail[]
  budgetUsage: BudgetUsage | null
  budgetLimits: BudgetLimits | null
  worlds: WorldStatus[]
  upgradePrompt: { feature: string; tier: string } | null
  hudVisible: boolean
}

const state: HUDState = {
  activePanel: null,
  panelStates: new Map(),
  notifications: [],
  assets: [],
  budgetUsage: null,
  budgetLimits: null,
  worlds: [],
  upgradePrompt: null,
  hudVisible: true,
}

// Callbacks for panel interactions
let onPanelAction: ((panel: HUDPanelType, action: string, data?: any) => void) | null = null

export function setHUDActionHandler(handler: (panel: HUDPanelType, action: string, data?: any) => void) {
  onPanelAction = handler
}

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

const COLORS = {
  bg: Color4.create(0.08, 0.08, 0.12, 0.95),
  bgLight: Color4.create(0.12, 0.12, 0.18, 1),
  bgHover: Color4.create(0.16, 0.16, 0.22, 1),
  border: Color4.create(0.2, 0.2, 0.28, 1),
  text: Color4.create(1, 1, 1, 1),
  textDim: Color4.create(0.6, 0.6, 0.65, 1),
  accent: Color4.create(0.38, 0.4, 0.95, 1),
  accentHover: Color4.create(0.28, 0.3, 0.85, 1),
  success: Color4.create(0.2, 0.8, 0.4, 1),
  warning: Color4.create(0.9, 0.7, 0.1, 1),
  danger: Color4.create(0.9, 0.3, 0.3, 1),
  transparent: Color4.create(0, 0, 0, 0),
}

// ---------------------------------------------------------------------------
// UI Components
// ---------------------------------------------------------------------------

function HUDToggleButton() {
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { right: 10, top: 10 },
        width: 36,
        height: 36,
      }}
      uiBackground={{ color: COLORS.accent }}
      onMouseDown={() => { state.hudVisible = !state.hudVisible }}
    >
      <Label value="VLM" fontSize={11} color={COLORS.text}
        uiTransform={{ width: 36, height: 36 }} />
    </UiEntity>
  )
}

function PanelHeader({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <UiEntity
      uiTransform={{
        width: '100%',
        height: 40,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: { left: 12, right: 8 },
      }}
      uiBackground={{ color: COLORS.bgLight }}
    >
      <Label value={title} fontSize={14} color={COLORS.text} />
      <UiEntity
        uiTransform={{ width: 28, height: 28 }}
        uiBackground={{ color: COLORS.danger }}
        onMouseDown={onClose}
      >
        <Label value="X" fontSize={12} color={COLORS.text}
          uiTransform={{ width: 28, height: 28 }} />
      </UiEntity>
    </UiEntity>
  )
}

function NavBar() {
  const panels: Array<{ type: HUDPanelType; label: string }> = [
    { type: HUDPanelType.SCENE_LAYOUT, label: 'Layout' },
    { type: HUDPanelType.ASSET_BROWSER, label: 'Assets' },
    { type: HUDPanelType.EVENT_CONTROL, label: 'Events' },
    { type: HUDPanelType.STREAM_CONTROL, label: 'Stream' },
    { type: HUDPanelType.WORLD_STATUS, label: 'Worlds' },
    { type: HUDPanelType.NOTIFICATIONS, label: 'Alerts' },
  ]

  return (
    <UiEntity
      uiTransform={{
        width: '100%',
        height: 36,
        flexDirection: 'row',
        alignItems: 'center',
      }}
      uiBackground={{ color: COLORS.bgLight }}
    >
      {panels.map(p => (
        <UiEntity
          key={p.type}
          uiTransform={{ height: 36, padding: { left: 10, right: 10 } }}
          uiBackground={{ color: state.activePanel === p.type ? COLORS.accent : COLORS.transparent }}
          onMouseDown={() => {
            state.activePanel = state.activePanel === p.type ? null : p.type
            onPanelAction?.(p.type, 'open')
          }}
        >
          <Label value={p.label} fontSize={11} color={state.activePanel === p.type ? COLORS.text : COLORS.textDim}
            uiTransform={{ height: 36 }} />
        </UiEntity>
      ))}
    </UiEntity>
  )
}

// ---------------------------------------------------------------------------
// Panel: Scene Layout
// ---------------------------------------------------------------------------

function SceneLayoutPanel() {
  const panelState = state.panelStates.get(HUDPanelType.SCENE_LAYOUT) as any
  const elements = panelState?.elements || []

  return (
    <UiEntity uiTransform={{ width: '100%', flexDirection: 'column' }}>
      <PanelHeader title="Scene Layout" onClose={() => { state.activePanel = null }} />
      <UiEntity uiTransform={{ padding: 8, flexDirection: 'column' }}>
        {elements.length === 0 ? (
          <Label value="No elements in scene" fontSize={12} color={COLORS.textDim} />
        ) : (
          elements.slice(0, 20).map((el: any, i: number) => (
            <UiEntity
              key={el.id || i}
              uiTransform={{
                width: '100%',
                height: 32,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: { left: 8, right: 8 },
                margin: { bottom: 2 },
              }}
              uiBackground={{ color: COLORS.bgLight }}
              onMouseDown={() => onPanelAction?.(HUDPanelType.SCENE_LAYOUT, 'select', { elementId: el.id })}
            >
              <Label value={`${el.type} | ${el.name}`} fontSize={11} color={COLORS.text} />
              <Label value={el.enabled ? 'ON' : 'OFF'} fontSize={10}
                color={el.enabled ? COLORS.success : COLORS.textDim} />
            </UiEntity>
          ))
        )}
      </UiEntity>
    </UiEntity>
  )
}

// ---------------------------------------------------------------------------
// Panel: Asset Browser
// ---------------------------------------------------------------------------

function AssetBrowserPanel() {
  return (
    <UiEntity uiTransform={{ width: '100%', flexDirection: 'column' }}>
      <PanelHeader title="Asset Browser" onClose={() => { state.activePanel = null }} />
      <UiEntity uiTransform={{ padding: 8, flexDirection: 'column' }}>
        {state.assets.length === 0 ? (
          <Label value="No assets loaded" fontSize={12} color={COLORS.textDim} />
        ) : (
          state.assets.slice(0, 15).map((asset, i) => (
            <UiEntity
              key={asset.id || i}
              uiTransform={{
                width: '100%',
                height: 36,
                flexDirection: 'row',
                alignItems: 'center',
                padding: { left: 8, right: 8 },
                margin: { bottom: 2 },
              }}
              uiBackground={{ color: COLORS.bgLight }}
              onMouseDown={() => onPanelAction?.(HUDPanelType.ASSET_BROWSER, 'place', { assetId: asset.id })}
            >
              <Label value={asset.name} fontSize={11} color={COLORS.text} />
              <Label value={asset.category || ''} fontSize={9} color={COLORS.textDim}
                uiTransform={{ margin: { left: 8 } }} />
            </UiEntity>
          ))
        )}
        {state.budgetUsage && state.budgetLimits && (
          <BudgetMeter usage={state.budgetUsage} limits={state.budgetLimits} />
        )}
      </UiEntity>
    </UiEntity>
  )
}

function BudgetMeter({ usage, limits }: { usage: BudgetUsage; limits: BudgetLimits }) {
  const triPct = limits.maxTriangleCount > 0 ? Math.min(100, (usage.triangleCount / limits.maxTriangleCount) * 100) : 0
  const entPct = limits.maxEntityCount > 0 ? Math.min(100, (usage.entityCount / limits.maxEntityCount) * 100) : 0

  const barColor = (pct: number) => pct > 90 ? COLORS.danger : pct > 70 ? COLORS.warning : COLORS.success

  return (
    <UiEntity uiTransform={{ width: '100%', flexDirection: 'column', margin: { top: 8 } }}>
      <Label value="Scene Budget" fontSize={10} color={COLORS.textDim} />
      <UiEntity uiTransform={{ width: '100%', height: 6, margin: { top: 4 } }} uiBackground={{ color: COLORS.bgLight }}>
        <UiEntity uiTransform={{ width: `${triPct}%` as any, height: 6 }} uiBackground={{ color: barColor(triPct) }} />
      </UiEntity>
      <Label value={`Triangles: ${usage.triangleCount} / ${limits.maxTriangleCount}`} fontSize={9} color={COLORS.textDim} />
      <UiEntity uiTransform={{ width: '100%', height: 6, margin: { top: 4 } }} uiBackground={{ color: COLORS.bgLight }}>
        <UiEntity uiTransform={{ width: `${entPct}%` as any, height: 6 }} uiBackground={{ color: barColor(entPct) }} />
      </UiEntity>
      <Label value={`Entities: ${usage.entityCount} / ${limits.maxEntityCount}`} fontSize={9} color={COLORS.textDim} />
    </UiEntity>
  )
}

// ---------------------------------------------------------------------------
// Panel: Event Control
// ---------------------------------------------------------------------------

function EventControlPanel() {
  const panelState = state.panelStates.get(HUDPanelType.EVENT_CONTROL) as any
  const events = panelState?.events || []

  return (
    <UiEntity uiTransform={{ width: '100%', flexDirection: 'column' }}>
      <PanelHeader title="Event Control" onClose={() => { state.activePanel = null }} />
      <UiEntity uiTransform={{ padding: 8, flexDirection: 'column' }}>
        {events.length === 0 ? (
          <Label value="No active events" fontSize={12} color={COLORS.textDim} />
        ) : (
          events.slice(0, 10).map((evt: any, i: number) => (
            <UiEntity
              key={evt.id || i}
              uiTransform={{
                width: '100%',
                height: 40,
                flexDirection: 'column',
                padding: { left: 8, right: 8, top: 4 },
                margin: { bottom: 2 },
              }}
              uiBackground={{ color: COLORS.bgLight }}
            >
              <Label value={evt.name} fontSize={11} color={COLORS.text} />
              <Label value={`Visitors: ${evt.visitorCount || 0}`} fontSize={9} color={COLORS.textDim} />
            </UiEntity>
          ))
        )}
        <UiEntity
          uiTransform={{ width: '100%', height: 32, margin: { top: 8 }, alignItems: 'center', justifyContent: 'center' }}
          uiBackground={{ color: COLORS.accent }}
          onMouseDown={() => onPanelAction?.(HUDPanelType.EVENT_CONTROL, 'switchPreset')}
        >
          <Label value="Switch Preset" fontSize={11} color={COLORS.text} />
        </UiEntity>
      </UiEntity>
    </UiEntity>
  )
}

// ---------------------------------------------------------------------------
// Panel: Stream Control
// ---------------------------------------------------------------------------

function StreamControlPanel() {
  const panelState = state.panelStates.get(HUDPanelType.STREAM_CONTROL) as any
  const streams = panelState?.streams || []

  return (
    <UiEntity uiTransform={{ width: '100%', flexDirection: 'column' }}>
      <PanelHeader title="Stream Control" onClose={() => { state.activePanel = null }} />
      <UiEntity uiTransform={{ padding: 8, flexDirection: 'column' }}>
        {streams.length === 0 ? (
          <Label value="No active streams" fontSize={12} color={COLORS.textDim} />
        ) : (
          streams.map((stream: any, i: number) => (
            <UiEntity
              key={stream.id || i}
              uiTransform={{
                width: '100%',
                height: 48,
                flexDirection: 'column',
                padding: 8,
                margin: { bottom: 2 },
              }}
              uiBackground={{ color: COLORS.bgLight }}
            >
              <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center' }}>
                <Label value={stream.isLive ? '● LIVE' : '○ OFFLINE'} fontSize={10}
                  color={stream.isLive ? COLORS.success : COLORS.textDim} />
                <Label value={stream.name || 'Stream'} fontSize={11} color={COLORS.text}
                  uiTransform={{ margin: { left: 8 } }} />
              </UiEntity>
              <UiEntity
                uiTransform={{ width: 80, height: 24, margin: { top: 4 }, alignItems: 'center', justifyContent: 'center' }}
                uiBackground={{ color: stream.isLive ? COLORS.danger : COLORS.success }}
                onMouseDown={() => onPanelAction?.(HUDPanelType.STREAM_CONTROL, stream.isLive ? 'goOffline' : 'goLive', { streamId: stream.id })}
              >
                <Label value={stream.isLive ? 'Go Offline' : 'Go Live'} fontSize={10} color={COLORS.text} />
              </UiEntity>
            </UiEntity>
          ))
        )}
      </UiEntity>
    </UiEntity>
  )
}

// ---------------------------------------------------------------------------
// Panel: World Status
// ---------------------------------------------------------------------------

function WorldStatusPanel() {
  return (
    <UiEntity uiTransform={{ width: '100%', flexDirection: 'column' }}>
      <PanelHeader title="World Status" onClose={() => { state.activePanel = null }} />
      <UiEntity uiTransform={{ padding: 8, flexDirection: 'column' }}>
        {state.worlds.length === 0 ? (
          <Label value="No connected worlds" fontSize={12} color={COLORS.textDim} />
        ) : (
          state.worlds.map((world, i) => (
            <UiEntity
              key={i}
              uiTransform={{
                width: '100%',
                height: 44,
                flexDirection: 'column',
                padding: 8,
                margin: { bottom: 2 },
              }}
              uiBackground={{ color: COLORS.bgLight }}
            >
              <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Label value={(world as any).sceneName || (world as any).platform || 'World'} fontSize={11} color={COLORS.text} />
                <Label value={`${(world as any).visitorCount || 0} visitors`} fontSize={10} color={COLORS.textDim} />
              </UiEntity>
              <Label value={(world as any).deploymentStatus || 'unknown'} fontSize={9}
                color={(world as any).deploymentStatus === 'deployed' ? COLORS.success : COLORS.textDim} />
            </UiEntity>
          ))
        )}
      </UiEntity>
    </UiEntity>
  )
}

// ---------------------------------------------------------------------------
// Panel: Notifications
// ---------------------------------------------------------------------------

function NotificationsPanel() {
  return (
    <UiEntity uiTransform={{ width: '100%', flexDirection: 'column' }}>
      <PanelHeader title="Notifications" onClose={() => { state.activePanel = null }} />
      <UiEntity uiTransform={{ padding: 8, flexDirection: 'column' }}>
        {state.notifications.length === 0 ? (
          <Label value="No notifications" fontSize={12} color={COLORS.textDim} />
        ) : (
          state.notifications.slice(0, 20).map((notif, i) => (
            <UiEntity
              key={i}
              uiTransform={{
                width: '100%',
                height: 32,
                flexDirection: 'row',
                alignItems: 'center',
                padding: { left: 8, right: 8 },
                margin: { bottom: 2 },
              }}
              uiBackground={{ color: COLORS.bgLight }}
            >
              <Label value={notif.message || ''} fontSize={10} color={COLORS.text} />
            </UiEntity>
          ))
        )}
      </UiEntity>
    </UiEntity>
  )
}

// ---------------------------------------------------------------------------
// Upgrade Prompt
// ---------------------------------------------------------------------------

function UpgradePrompt() {
  if (!state.upgradePrompt) return null
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { top: '30%', left: '25%' },
        width: '50%',
        flexDirection: 'column',
        padding: 16,
      }}
      uiBackground={{ color: COLORS.bg }}
    >
      <Label value="Upgrade Required" fontSize={16} color={COLORS.warning} />
      <Label value={`The "${state.upgradePrompt.feature}" feature requires the ${state.upgradePrompt.tier} tier.`}
        fontSize={12} color={COLORS.text} uiTransform={{ margin: { top: 8 } }} />
      <UiEntity
        uiTransform={{ width: 100, height: 32, margin: { top: 12 }, alignItems: 'center', justifyContent: 'center' }}
        uiBackground={{ color: COLORS.accent }}
        onMouseDown={() => { state.upgradePrompt = null }}
      >
        <Label value="OK" fontSize={12} color={COLORS.text} />
      </UiEntity>
    </UiEntity>
  )
}

// ---------------------------------------------------------------------------
// Notification Toast (overlay)
// ---------------------------------------------------------------------------

function NotificationToast() {
  const recent = state.notifications.slice(0, 3)
  if (recent.length === 0) return null

  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { bottom: 60, right: 10 },
        width: 280,
        flexDirection: 'column',
      }}
    >
      {recent.map((notif, i) => (
        <UiEntity
          key={i}
          uiTransform={{
            width: '100%',
            height: 28,
            alignItems: 'center',
            padding: { left: 8, right: 8 },
            margin: { bottom: 4 },
          }}
          uiBackground={{ color: COLORS.bg }}
        >
          <Label value={notif.message || ''} fontSize={10} color={COLORS.text} />
        </UiEntity>
      ))}
    </UiEntity>
  )
}

// ---------------------------------------------------------------------------
// Main HUD Component
// ---------------------------------------------------------------------------

function VLMHUD() {
  return (
    <UiEntity uiTransform={{ width: '100%', height: '100%', positionType: 'absolute' }}>
      <HUDToggleButton />

      {state.hudVisible && state.activePanel !== null && (
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: { right: 10, top: 52 },
            width: 320,
            maxHeight: 500,
            flexDirection: 'column',
          }}
          uiBackground={{ color: COLORS.bg }}
        >
          <NavBar />
          {state.activePanel === HUDPanelType.SCENE_LAYOUT && <SceneLayoutPanel />}
          {state.activePanel === HUDPanelType.ASSET_BROWSER && <AssetBrowserPanel />}
          {state.activePanel === HUDPanelType.EVENT_CONTROL && <EventControlPanel />}
          {state.activePanel === HUDPanelType.STREAM_CONTROL && <StreamControlPanel />}
          {state.activePanel === HUDPanelType.WORLD_STATUS && <WorldStatusPanel />}
          {state.activePanel === HUDPanelType.NOTIFICATIONS && <NotificationsPanel />}
        </UiEntity>
      )}

      {state.hudVisible && <NotificationToast />}
      <UpgradePrompt />
    </UiEntity>
  )
}

// ---------------------------------------------------------------------------
// DclHUDRenderer — implements HUDRenderer
// ---------------------------------------------------------------------------

export class DclHUDRenderer implements HUDRenderer {
  private initialized = false

  init() {
    if (this.initialized) return
    this.initialized = true
    ReactEcsRenderer.setUiRenderer(VLMHUD)
    console.log('[VLM HUD] DCL HUD renderer initialized')
  }

  showPanel(panel: HUDPanelType, panelState: HUDPanelState): void {
    state.activePanel = panel
    state.panelStates.set(panel, panelState)
  }

  hidePanel(panel: HUDPanelType): void {
    if (state.activePanel === panel) {
      state.activePanel = null
    }
  }

  renderAssetGrid(assets: AssetThumbnail[]): void {
    state.assets = assets
  }

  showTransformGizmo(_entity: EntityHandle, _mode: 'move' | 'rotate' | 'scale'): void {
    // DCL doesn't support custom transform gizmos in screen-space UI
    // This would need a 3D gizmo implementation using ECS entities
  }

  hideTransformGizmo(): void {
    // No-op — see showTransformGizmo
  }

  showNotification(notification: HUDNotification): void {
    state.notifications = [notification, ...state.notifications].slice(0, 50)
    // Auto-dismiss after 5 seconds
    setTimeout(() => {
      state.notifications = state.notifications.filter(n => n !== notification)
    }, 5000)
  }

  renderBudgetMeter(usage: BudgetUsage, limits: BudgetLimits): void {
    state.budgetUsage = usage
    state.budgetLimits = limits
  }

  showUpgradePrompt(feature: string, tier: string): void {
    state.upgradePrompt = { feature, tier }
  }

  renderWorldStatusGrid(worlds: WorldStatus[]): void {
    state.worlds = worlds
  }

  supportsPanel(panel: HUDPanelType): boolean {
    // Support all panels except transform gizmo (which is 3D, not screen-space)
    return true
  }
}
