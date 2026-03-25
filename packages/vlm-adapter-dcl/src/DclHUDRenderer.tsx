/**
 * Decentraland HUD Renderer
 *
 * Implements the VLM HUDRenderer interface using DCL SDK 7's ReactECS UI system.
 * Renders management panels as screen-space overlay UI.
 *
 * Supports a "setup" flow for first-time users:
 *   idle → authenticating → scene_setup → connected → management panels
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
  Scene,
} from 'vlm-shared'
import { HUDPanelType } from 'vlm-shared'
import type { EntityHandle, WorldStatus } from 'vlm-shared'
import type { VLMConnectionState } from 'vlm-core'

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface HUDState {
  // Connection state
  connectionState: VLMConnectionState
  statusMessage: string
  errorMessage: string | null
  userName: string | null
  userScenes: Scene[]
  currentSceneId: string | null
  currentSceneName: string | null
  isNewScene: boolean

  // Panel state (active once connected)
  activePanel: HUDPanelType | null
  panelStates: Map<HUDPanelType, HUDPanelState>
  notifications: HUDNotification[]
  assets: AssetThumbnail[]
  budgetUsage: BudgetUsage | null
  budgetLimits: BudgetLimits | null
  worlds: WorldStatus[]
  upgradePrompt: { feature: string; tier: string } | null
  hudVisible: boolean

  // Scene creation
  newSceneName: string
}

const state: HUDState = {
  connectionState: 'idle',
  statusMessage: 'Initializing...',
  errorMessage: null,
  userName: null,
  userScenes: [],
  currentSceneId: null,
  currentSceneName: null,
  isNewScene: false,

  activePanel: null,
  panelStates: new Map(),
  notifications: [],
  assets: [],
  budgetUsage: null,
  budgetLimits: null,
  worlds: [],
  upgradePrompt: null,
  hudVisible: true,

  newSceneName: '',
}

// Callbacks
let onPanelAction: ((panel: HUDPanelType, action: string, data?: any) => void) | null = null
let onSceneAction: ((action: string, data?: any) => void) | null = null

export function setHUDActionHandler(handler: (panel: HUDPanelType, action: string, data?: any) => void) {
  onPanelAction = handler
}

export function setSceneActionHandler(handler: (action: string, data?: any) => void) {
  onSceneAction = handler
}

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

const C = {
  bg: Color4.create(0.06, 0.06, 0.1, 0.96),
  bgLight: Color4.create(0.1, 0.1, 0.16, 1),
  bgHover: Color4.create(0.14, 0.14, 0.2, 1),
  bgCard: Color4.create(0.09, 0.09, 0.14, 1),
  border: Color4.create(0.18, 0.18, 0.26, 1),
  text: Color4.create(1, 1, 1, 1),
  textDim: Color4.create(0.55, 0.55, 0.6, 1),
  textMuted: Color4.create(0.4, 0.4, 0.45, 1),
  accent: Color4.create(0.35, 0.38, 0.92, 1),
  accentHover: Color4.create(0.25, 0.28, 0.82, 1),
  accentSoft: Color4.create(0.35, 0.38, 0.92, 0.15),
  success: Color4.create(0.18, 0.75, 0.38, 1),
  successSoft: Color4.create(0.18, 0.75, 0.38, 0.15),
  warning: Color4.create(0.88, 0.68, 0.08, 1),
  danger: Color4.create(0.88, 0.28, 0.28, 1),
  transparent: Color4.create(0, 0, 0, 0),
  white08: Color4.create(1, 1, 1, 0.08),
  white15: Color4.create(1, 1, 1, 0.15),
}

// ---------------------------------------------------------------------------
// Shared Components
// ---------------------------------------------------------------------------

function HUDToggleButton() {
  const isConnected = state.connectionState === 'connected'
  const dotColor = isConnected ? C.success : state.connectionState === 'error' ? C.danger : C.warning

  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { right: 12, top: 12 },
        width: 44,
        height: 44,
        alignItems: 'center',
        justifyContent: 'center',
      }}
      uiBackground={{ color: C.bg }}
      onMouseDown={() => { state.hudVisible = !state.hudVisible }}
    >
      <Label value="VLM" fontSize={12} color={C.text}
        uiTransform={{ width: 44, height: 34 }} />
      {/* Status dot */}
      <UiEntity
        uiTransform={{
          positionType: 'absolute',
          position: { right: 4, bottom: 4 },
          width: 8,
          height: 8,
        }}
        uiBackground={{ color: dotColor }}
      />
    </UiEntity>
  )
}

function PanelHeader({ title, onClose, subtitle }: { title: string; onClose: () => void; subtitle?: string }) {
  return (
    <UiEntity
      uiTransform={{
        width: '100%',
        height: subtitle ? 48 : 40,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: { left: 14, right: 10, top: 4, bottom: 4 },
      }}
      uiBackground={{ color: C.bgLight }}
    >
      <UiEntity uiTransform={{ flexDirection: 'column' }}>
        <Label value={title} fontSize={14} color={C.text} />
        {subtitle && <Label value={subtitle} fontSize={9} color={C.textDim} />}
      </UiEntity>
      <UiEntity
        uiTransform={{ width: 28, height: 28, alignItems: 'center', justifyContent: 'center' }}
        uiBackground={{ color: C.white08 }}
        onMouseDown={onClose}
      >
        <Label value="X" fontSize={12} color={C.textDim}
          uiTransform={{ width: 28, height: 28 }} />
      </UiEntity>
    </UiEntity>
  )
}

function Button({ label, color, textColor, onPress, width, height, fontSize }: {
  label: string; color: ReturnType<typeof Color4.create>;
  textColor?: ReturnType<typeof Color4.create>;
  onPress: () => void; width?: number; height?: number; fontSize?: number
}) {
  const w = width || ('100%' as any)
  const h = height || 36
  return (
    <UiEntity
      uiTransform={{
        width: w,
        height: h,
        alignItems: 'center',
        justifyContent: 'center',
      }}
      uiBackground={{ color }}
      onMouseDown={onPress}
    >
      <Label value={label} fontSize={fontSize || 12} color={textColor || C.text}
        uiTransform={{ width: w, height: h }} />
    </UiEntity>
  )
}

function Divider() {
  return (
    <UiEntity
      uiTransform={{ width: '100%', height: 1, margin: { top: 4, bottom: 4 } }}
      uiBackground={{ color: C.white08 }}
    />
  )
}

// ---------------------------------------------------------------------------
// Setup Flow Screens
// ---------------------------------------------------------------------------

function ConnectingScreen() {
  const messages: Record<string, string> = {
    idle: 'Initializing VLM...',
    authenticating: 'Authenticating with Decentraland...',
    authenticated: 'Signed in! Loading scenes...',
    discovering_scene: 'Looking for your scenes...',
    scene_ready: 'Scene found! Connecting...',
    connecting: 'Connecting to scene...',
    connected: 'Connected!',
    error: 'Connection failed',
  }

  const msg = state.statusMessage || messages[state.connectionState] || 'Working...'

  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { right: 12, top: 62 },
        width: 320,
        flexDirection: 'column',
        padding: 16,
      }}
      uiBackground={{ color: C.bg }}
    >
      {/* VLM Header */}
      <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', alignItems: 'center', margin: { bottom: 12 } }}>
        <Label value="Virtual Land Manager" fontSize={16} color={C.text} />
      </UiEntity>

      {/* Status */}
      <UiEntity uiTransform={{ width: '100%', flexDirection: 'column', alignItems: 'center', padding: 16 }}>
        <Label value={msg} fontSize={12} color={C.textDim} />

        {/* Progress dots animation */}
        {state.connectionState !== 'error' && state.connectionState !== 'connected' && (
          <Label value="..." fontSize={18} color={C.accent}
            uiTransform={{ margin: { top: 8 } }} />
        )}

        {/* Error display */}
        {state.connectionState === 'error' && state.errorMessage && (
          <UiEntity uiTransform={{ width: '100%', margin: { top: 8 }, padding: 8 }}
            uiBackground={{ color: Color4.create(0.88, 0.28, 0.28, 0.15) }}>
            <Label value={state.errorMessage} fontSize={10} color={C.danger} />
          </UiEntity>
        )}

        {/* Retry button on error */}
        {state.connectionState === 'error' && (
          <UiEntity uiTransform={{ margin: { top: 12 } }}>
            <Button label="Retry" color={C.accent}
              onPress={() => onSceneAction?.('retry')} width={100} />
          </UiEntity>
        )}
      </UiEntity>

      {/* User info if authenticated */}
      {state.userName && (
        <UiEntity uiTransform={{ width: '100%', margin: { top: 8 } }}>
          <Divider />
          <Label value={`Signed in as ${state.userName}`} fontSize={10} color={C.textMuted}
            uiTransform={{ margin: { top: 4 } }} />
        </UiEntity>
      )}
    </UiEntity>
  )
}

function SceneSetupScreen() {
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { right: 12, top: 62 },
        width: 340,
        flexDirection: 'column',
      }}
      uiBackground={{ color: C.bg }}
    >
      {/* Header */}
      <UiEntity
        uiTransform={{
          width: '100%',
          height: 52,
          flexDirection: 'column',
          justifyContent: 'center',
          padding: { left: 14, right: 14 },
        }}
        uiBackground={{ color: C.bgLight }}
      >
        <Label value="Virtual Land Manager" fontSize={15} color={C.text} />
        <Label value={state.userName ? `Welcome, ${state.userName}` : 'Scene Setup'} fontSize={10} color={C.textDim} />
      </UiEntity>

      <UiEntity uiTransform={{ padding: { left: 14, right: 14, top: 12, bottom: 14 }, flexDirection: 'column' }}>
        {/* Existing scenes */}
        {state.userScenes.length > 0 && (
          <UiEntity uiTransform={{ width: '100%', flexDirection: 'column', margin: { bottom: 12 } }}>
            <Label value="Your Scenes" fontSize={12} color={C.text}
              uiTransform={{ margin: { bottom: 6 } }} />
            {state.userScenes.slice(0, 5).map((scene, i) => (
              <UiEntity
                key={scene.id || i}
                uiTransform={{
                  width: '100%',
                  height: 40,
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: { left: 10, right: 10 },
                  margin: { bottom: 3 },
                }}
                uiBackground={{ color: C.bgCard }}
                onMouseDown={() => onSceneAction?.('select_scene', { sceneId: scene.id })}
              >
                <UiEntity uiTransform={{ flexDirection: 'column' }}>
                  <Label value={scene.name || 'Untitled'} fontSize={11} color={C.text} />
                  <Label value={scene.id.slice(0, 8) + '...'} fontSize={8} color={C.textMuted} />
                </UiEntity>
                <Label value="Connect >" fontSize={10} color={C.accent} />
              </UiEntity>
            ))}
          </UiEntity>
        )}

        <Divider />

        {/* Create new scene */}
        <UiEntity uiTransform={{ width: '100%', flexDirection: 'column', margin: { top: 8 } }}>
          <Label value={state.userScenes.length > 0 ? 'Or Create New' : 'Create Your First Scene'} fontSize={12} color={C.text}
            uiTransform={{ margin: { bottom: 6 } }} />

          <Label value="Scene Name" fontSize={10} color={C.textDim}
            uiTransform={{ margin: { bottom: 3 } }} />
          <Input
            uiTransform={{ width: '100%', height: 36 }}
            uiBackground={{ color: C.bgCard }}
            color={C.text}
            placeholderColor={C.textMuted}
            placeholder="My Awesome Scene"
            fontSize={12}
            value={state.newSceneName}
            onChange={(value) => { state.newSceneName = value }}
          />

          <UiEntity uiTransform={{ margin: { top: 10 } }}>
            <Button
              label="Create Scene"
              color={C.accent}
              onPress={() => {
                const name = state.newSceneName.trim() || `${state.userName || 'My'}'s Scene`
                onSceneAction?.('create_scene', { name })
              }}
            />
          </UiEntity>
        </UiEntity>

        {/* Info text */}
        <UiEntity uiTransform={{ margin: { top: 12 } }}>
          <Label
            value="Your Decentraland wallet is automatically linked to your VLM account."
            fontSize={9}
            color={C.textMuted}
          />
        </UiEntity>
      </UiEntity>
    </UiEntity>
  )
}

function ConnectedBanner() {
  if (!state.isNewScene) return null

  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { right: 12, top: 62 },
        width: 320,
        flexDirection: 'column',
        padding: 14,
      }}
      uiBackground={{ color: C.bg }}
    >
      <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', margin: { bottom: 8 } }}>
        <Label value="+" fontSize={14} color={C.success} uiTransform={{ margin: { right: 6 } }} />
        <Label value="Scene Created!" fontSize={14} color={C.text} />
      </UiEntity>
      <Label value={`"${state.currentSceneName || 'New Scene'}" is ready.`} fontSize={11} color={C.textDim} />
      <Label value="Use the VLM button to manage your scene." fontSize={10} color={C.textMuted}
        uiTransform={{ margin: { top: 4 } }} />
      <UiEntity uiTransform={{ margin: { top: 10 } }}>
        <Button label="Got it" color={C.accent}
          onPress={() => { state.isNewScene = false }} />
      </UiEntity>
    </UiEntity>
  )
}

// ---------------------------------------------------------------------------
// Nav Bar (connected state)
// ---------------------------------------------------------------------------

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
      uiBackground={{ color: C.bgLight }}
    >
      {panels.map(p => (
        <UiEntity
          key={p.type}
          uiTransform={{ height: 36, padding: { left: 10, right: 10 } }}
          uiBackground={{ color: state.activePanel === p.type ? C.accent : C.transparent }}
          onMouseDown={() => {
            state.activePanel = state.activePanel === p.type ? null : p.type
            onPanelAction?.(p.type, 'open')
          }}
        >
          <Label value={p.label} fontSize={11} color={state.activePanel === p.type ? C.text : C.textDim}
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
      <PanelHeader
        title="Scene Layout"
        subtitle={state.currentSceneName || undefined}
        onClose={() => { state.activePanel = null }}
      />
      <UiEntity uiTransform={{ padding: 8, flexDirection: 'column' }}>
        {elements.length === 0 ? (
          <UiEntity uiTransform={{ padding: 16, flexDirection: 'column', alignItems: 'center' }}>
            <Label value="No elements yet" fontSize={12} color={C.textDim} />
            <Label value="Add elements from the Assets panel" fontSize={10} color={C.textMuted}
              uiTransform={{ margin: { top: 4 } }} />
          </UiEntity>
        ) : (
          elements.slice(0, 20).map((el: any, i: number) => (
            <UiEntity
              key={el.id || i}
              uiTransform={{
                width: '100%',
                height: 34,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: { left: 10, right: 10 },
                margin: { bottom: 2 },
              }}
              uiBackground={{ color: C.bgCard }}
              onMouseDown={() => onPanelAction?.(HUDPanelType.SCENE_LAYOUT, 'select', { elementId: el.id })}
            >
              <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center' }}>
                <Label value={el.type?.toUpperCase()?.slice(0, 3) || '???'} fontSize={8} color={C.textMuted}
                  uiTransform={{ margin: { right: 6 } }} />
                <Label value={el.name || 'Unnamed'} fontSize={11} color={C.text} />
              </UiEntity>
              <Label value={el.enabled ? 'ON' : 'OFF'} fontSize={9}
                color={el.enabled ? C.success : C.textDim} />
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
          <UiEntity uiTransform={{ padding: 16, flexDirection: 'column', alignItems: 'center' }}>
            <Label value="No assets loaded" fontSize={12} color={C.textDim} />
            <Label value="Assets will appear here from your library" fontSize={10} color={C.textMuted}
              uiTransform={{ margin: { top: 4 } }} />
          </UiEntity>
        ) : (
          state.assets.slice(0, 15).map((asset, i) => (
            <UiEntity
              key={asset.id || i}
              uiTransform={{
                width: '100%',
                height: 38,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: { left: 10, right: 10 },
                margin: { bottom: 2 },
              }}
              uiBackground={{ color: C.bgCard }}
              onMouseDown={() => onPanelAction?.(HUDPanelType.ASSET_BROWSER, 'place', { assetId: asset.id })}
            >
              <Label value={asset.name} fontSize={11} color={C.text} />
              <Label value={asset.category || ''} fontSize={9} color={C.textDim} />
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
  const barColor = (pct: number) => pct > 90 ? C.danger : pct > 70 ? C.warning : C.success

  return (
    <UiEntity uiTransform={{ width: '100%', flexDirection: 'column', margin: { top: 10 }, padding: { top: 8 } }}>
      <Label value="Scene Budget" fontSize={10} color={C.textDim} />
      <UiEntity uiTransform={{ width: '100%', height: 6, margin: { top: 4 } }} uiBackground={{ color: C.bgLight }}>
        <UiEntity uiTransform={{ width: `${triPct}%` as any, height: 6 }} uiBackground={{ color: barColor(triPct) }} />
      </UiEntity>
      <Label value={`Triangles: ${usage.triangleCount} / ${limits.maxTriangleCount}`} fontSize={9} color={C.textMuted} />
      <UiEntity uiTransform={{ width: '100%', height: 6, margin: { top: 4 } }} uiBackground={{ color: C.bgLight }}>
        <UiEntity uiTransform={{ width: `${entPct}%` as any, height: 6 }} uiBackground={{ color: barColor(entPct) }} />
      </UiEntity>
      <Label value={`Entities: ${usage.entityCount} / ${limits.maxEntityCount}`} fontSize={9} color={C.textMuted} />
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
          <UiEntity uiTransform={{ padding: 16, alignItems: 'center' }}>
            <Label value="No active events" fontSize={12} color={C.textDim} />
          </UiEntity>
        ) : (
          events.slice(0, 10).map((evt: any, i: number) => (
            <UiEntity
              key={evt.id || i}
              uiTransform={{
                width: '100%',
                height: 42,
                flexDirection: 'column',
                padding: { left: 10, right: 10, top: 6 },
                margin: { bottom: 2 },
              }}
              uiBackground={{ color: C.bgCard }}
            >
              <Label value={evt.name} fontSize={11} color={C.text} />
              <Label value={`Visitors: ${evt.visitorCount || 0}`} fontSize={9} color={C.textDim} />
            </UiEntity>
          ))
        )}
        <UiEntity uiTransform={{ margin: { top: 8 } }}>
          <Button label="Switch Preset" color={C.accent}
            onPress={() => onPanelAction?.(HUDPanelType.EVENT_CONTROL, 'switchPreset')} />
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
          <UiEntity uiTransform={{ padding: 16, alignItems: 'center' }}>
            <Label value="No active streams" fontSize={12} color={C.textDim} />
          </UiEntity>
        ) : (
          streams.map((stream: any, i: number) => (
            <UiEntity
              key={stream.id || i}
              uiTransform={{
                width: '100%',
                height: 52,
                flexDirection: 'column',
                padding: 10,
                margin: { bottom: 2 },
              }}
              uiBackground={{ color: C.bgCard }}
            >
              <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center' }}>
                <Label value={stream.isLive ? '* LIVE' : '  OFFLINE'} fontSize={10}
                  color={stream.isLive ? C.success : C.textDim} />
                <Label value={stream.name || 'Stream'} fontSize={11} color={C.text}
                  uiTransform={{ margin: { left: 8 } }} />
              </UiEntity>
              <UiEntity uiTransform={{ margin: { top: 6 } }}>
                <Button
                  label={stream.isLive ? 'Go Offline' : 'Go Live'}
                  color={stream.isLive ? C.danger : C.success}
                  onPress={() => onPanelAction?.(HUDPanelType.STREAM_CONTROL, stream.isLive ? 'goOffline' : 'goLive', { streamId: stream.id })}
                  width={90}
                  height={26}
                  fontSize={10}
                />
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
          <UiEntity uiTransform={{ padding: 16, alignItems: 'center' }}>
            <Label value="No connected worlds" fontSize={12} color={C.textDim} />
          </UiEntity>
        ) : (
          state.worlds.map((world, i) => (
            <UiEntity
              key={i}
              uiTransform={{
                width: '100%',
                height: 46,
                flexDirection: 'column',
                padding: 10,
                margin: { bottom: 2 },
              }}
              uiBackground={{ color: C.bgCard }}
            >
              <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Label value={(world as any).sceneName || (world as any).platform || 'World'} fontSize={11} color={C.text} />
                <Label value={`${(world as any).visitorCount || 0} visitors`} fontSize={10} color={C.textDim} />
              </UiEntity>
              <Label value={(world as any).deploymentStatus || 'unknown'} fontSize={9}
                color={(world as any).deploymentStatus === 'deployed' ? C.success : C.textDim} />
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
          <UiEntity uiTransform={{ padding: 16, alignItems: 'center' }}>
            <Label value="No notifications" fontSize={12} color={C.textDim} />
          </UiEntity>
        ) : (
          state.notifications.slice(0, 20).map((notif, i) => (
            <UiEntity
              key={i}
              uiTransform={{
                width: '100%',
                height: 32,
                flexDirection: 'row',
                alignItems: 'center',
                padding: { left: 10, right: 10 },
                margin: { bottom: 2 },
              }}
              uiBackground={{ color: C.bgCard }}
            >
              <Label value={notif.message || notif.title || ''} fontSize={10} color={C.text} />
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
      uiBackground={{ color: C.bg }}
    >
      <Label value="Upgrade Required" fontSize={16} color={C.warning} />
      <Label value={`The "${state.upgradePrompt.feature}" feature requires the ${state.upgradePrompt.tier} tier.`}
        fontSize={12} color={C.text} uiTransform={{ margin: { top: 8 } }} />
      <UiEntity uiTransform={{ margin: { top: 12 } }}>
        <Button label="OK" color={C.accent} width={100}
          onPress={() => { state.upgradePrompt = null }} />
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
        position: { bottom: 60, right: 12 },
        width: 280,
        flexDirection: 'column',
      }}
    >
      {recent.map((notif, i) => (
        <UiEntity
          key={i}
          uiTransform={{
            width: '100%',
            height: 30,
            alignItems: 'center',
            padding: { left: 10, right: 10 },
            margin: { bottom: 4 },
          }}
          uiBackground={{ color: C.bg }}
        >
          <Label value={notif.message || notif.title || ''} fontSize={10} color={C.text} />
        </UiEntity>
      ))}
    </UiEntity>
  )
}

// ---------------------------------------------------------------------------
// Main HUD Component
// ---------------------------------------------------------------------------

function VLMHUD() {
  const isSetup = state.connectionState !== 'connected' || state.isNewScene

  return (
    <UiEntity uiTransform={{ width: '100%', height: '100%', positionType: 'absolute' }}>
      <HUDToggleButton />

      {state.hudVisible && (() => {
        // Pre-connection: show setup flow
        if (state.connectionState === 'idle' ||
            state.connectionState === 'authenticating' ||
            state.connectionState === 'connecting' ||
            state.connectionState === 'error') {
          return <ConnectingScreen />
        }

        // Authenticated but needs scene selection/creation
        if (state.connectionState === 'authenticated' ||
            state.connectionState === 'discovering_scene') {
          if (state.userScenes.length > 0 || state.connectionState === 'authenticated') {
            return <SceneSetupScreen />
          }
          return <ConnectingScreen />
        }

        // Scene ready but not yet connected to Colyseus
        if (state.connectionState === 'scene_ready') {
          return <ConnectingScreen />
        }

        // Connected — show new scene banner or management panels
        if (state.connectionState === 'connected') {
          if (state.isNewScene) {
            return <ConnectedBanner />
          }

          if (state.activePanel !== null) {
            return (
              <UiEntity
                uiTransform={{
                  positionType: 'absolute',
                  position: { right: 12, top: 62 },
                  width: 340,
                  maxHeight: 520,
                  flexDirection: 'column',
                }}
                uiBackground={{ color: C.bg }}
              >
                <NavBar />
                {state.activePanel === HUDPanelType.SCENE_LAYOUT && <SceneLayoutPanel />}
                {state.activePanel === HUDPanelType.ASSET_BROWSER && <AssetBrowserPanel />}
                {state.activePanel === HUDPanelType.EVENT_CONTROL && <EventControlPanel />}
                {state.activePanel === HUDPanelType.STREAM_CONTROL && <StreamControlPanel />}
                {state.activePanel === HUDPanelType.WORLD_STATUS && <WorldStatusPanel />}
                {state.activePanel === HUDPanelType.NOTIFICATIONS && <NotificationsPanel />}
              </UiEntity>
            )
          }
        }

        return null
      })()}

      {state.hudVisible && state.connectionState === 'connected' && !state.isNewScene && <NotificationToast />}
      <UpgradePrompt />
    </UiEntity>
  )
}

// ---------------------------------------------------------------------------
// DclHUDRenderer — implements HUDRenderer + setup state management
// ---------------------------------------------------------------------------

export class DclHUDRenderer implements HUDRenderer {
  private initialized = false

  init() {
    if (this.initialized) return
    this.initialized = true
    ReactEcsRenderer.setUiRenderer(VLMHUD)
    console.log('[VLM HUD] DCL HUD renderer initialized')
  }

  // --- Connection state updates (called by the createVLM flow) ---

  updateConnectionState(connectionState: VLMConnectionState, detail?: Record<string, unknown>): void {
    state.connectionState = connectionState

    if (detail?.error) {
      state.errorMessage = String(detail.error)
    }
    if (detail?.user) {
      const user = detail.user as any
      state.userName = user.displayName || user.email || null
    }
    if (detail?.scenes) {
      state.userScenes = detail.scenes as Scene[]
    }
    if (detail?.sceneId) {
      state.currentSceneId = detail.sceneId as string
    }
    if (detail?.sceneName) {
      state.currentSceneName = detail.sceneName as string
    }
    if (detail?.isNew) {
      state.isNewScene = true
    }

    // Auto-set status messages
    const messages: Record<string, string> = {
      idle: 'Initializing...',
      authenticating: 'Signing in with your wallet...',
      authenticated: 'Authenticated!',
      discovering_scene: 'Finding your scenes...',
      scene_ready: 'Connecting to scene...',
      connecting: 'Joining scene room...',
      connected: 'Connected!',
      error: 'Something went wrong',
    }
    state.statusMessage = messages[connectionState] || ''
  }

  setScenes(scenes: Scene[]): void {
    state.userScenes = scenes
  }

  setCurrentScene(sceneId: string, sceneName: string): void {
    state.currentSceneId = sceneId
    state.currentSceneName = sceneName
  }

  // --- HUDRenderer interface ---

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
  }

  hideTransformGizmo(): void {}

  showNotification(notification: HUDNotification): void {
    state.notifications = [notification, ...state.notifications].slice(0, 50)
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
    return true
  }
}
