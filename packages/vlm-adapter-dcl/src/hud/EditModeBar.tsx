// Floating bar for in-world transform editing: mode buttons, the selected item, Move's axis lock, Save / Revert / Done,
// the held / error message and the "Save or revert first" prompt. Rendered by DclHUDRenderer from its module state.
import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { markHudPress } from './press.js'
import type { MoveLock, TransformMode } from 'vlm-core'

export interface EditModeHUDState {
  active: boolean
  mode: TransformMode
  lock: MoveLock
  selectedName: string | null
  dirty: boolean
  message: string | null
  prompt: boolean
}

export const NO_EDIT_MODE: EditModeHUDState = {
  active: false, mode: 'move', lock: 'free', selectedName: null, dirty: false, message: null, prompt: false,
}

const BG = Color4.create(0.06, 0.06, 0.1, 0.96)
const BTN = Color4.create(0.14, 0.14, 0.2, 1)
const BTN_OFF = Color4.create(0.09, 0.09, 0.14, 1)
const ACCENT = Color4.create(0.35, 0.38, 0.92, 1)
const DANGER = Color4.create(0.88, 0.28, 0.28, 1)
const WARN = Color4.create(0.88, 0.68, 0.08, 1)
const WHITE = Color4.create(1, 1, 1, 1)
const DIM = Color4.create(0.4, 0.4, 0.45, 1)
const LOCK_COLORS: Record<string, Color4> = {
  free: Color4.create(0.75, 0.75, 0.8, 1),
  x: Color4.create(0.92, 0.3, 0.3, 1),
  y: Color4.create(0.3, 0.85, 0.4, 1),
  z: Color4.create(0.35, 0.55, 0.95, 1),
}

const BAR_W = 640
const BAR_H = 44
const PROMPT_W = 400
const PROMPT_H = 70
const MESSAGE_H = 22
const BOTTOM = 20

type Act = (action: string, data?: any) => void

function Btn({ label, onPress, width, color, off }: { label: string; onPress: () => void; width: number; color?: Color4; off?: boolean; key?: string }) {
  return (
    <UiEntity
      uiTransform={{ width, height: 30, margin: { left: 3, right: 3 }, alignItems: 'center', justifyContent: 'center' }}
      uiBackground={{ color: off ? BTN_OFF : color ?? BTN }}
      onMouseDown={() => { markHudPress(); if (!off) onPress() }}
    >
      <Label value={label} fontSize={11} color={off ? DIM : WHITE} />
    </UiEntity>
  )
}

export function EditModeBar({ s, act }: { s: EditModeHUDState; act: Act }) {
  const name = s.selectedName ?? 'this item'
  const modes: Array<[TransformMode, string]> = [['move', 'Move'], ['rotate', 'Rotate'], ['resize', 'Resize']]
  return (
    <UiEntity
      uiTransform={{ positionType: 'absolute', position: { bottom: BOTTOM, left: 0 }, width: '100%', flexDirection: 'column', alignItems: 'center' }}
    >
      {s.message && (
        <UiEntity uiTransform={{ width: PROMPT_W, height: MESSAGE_H, alignItems: 'center', justifyContent: 'center', margin: { bottom: 4 } }} uiBackground={{ color: BG }} onMouseDown={markHudPress}>
          <Label value={s.message} fontSize={10} color={WARN} />
        </UiEntity>
      )}
      {s.prompt && (
        <UiEntity
          uiTransform={{ width: PROMPT_W, height: PROMPT_H, margin: { bottom: 4 }, flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}
          uiBackground={{ color: BG }}
          onMouseDown={markHudPress}
        >
          <Label value={`Save or revert changes to ${name} first.`} fontSize={11} color={WHITE} uiTransform={{ height: 26 }} />
          <UiEntity uiTransform={{ flexDirection: 'row' }}>
            <Btn label="Save" width={80} color={ACCENT} onPress={() => act('edit_save')} />
            <Btn label="Revert" width={80} color={DANGER} onPress={() => act('edit_revert')} />
          </UiEntity>
        </UiEntity>
      )}
      <UiEntity
        uiTransform={{ width: BAR_W, height: BAR_H, flexDirection: 'row', alignItems: 'center', padding: { left: 6, right: 6 } }}
        uiBackground={{ color: BG }}
        onMouseDown={markHudPress}
      >
        {modes.map(([m, label]) => (
          <Btn key={m} label={label} width={64} color={s.mode === m ? ACCENT : BTN} onPress={() => act('edit_mode', { mode: m })} />
        ))}
        <Label
          value={s.selectedName ?? 'Click an item to select it'}
          fontSize={11}
          color={s.selectedName ? WHITE : DIM}
          uiTransform={{ width: 150, height: 30, margin: { left: 6, right: 6 } }}
        />
        {s.mode === 'move' && (
          <Label value={s.lock === 'free' ? 'Free' : s.lock.toUpperCase()} fontSize={12} color={LOCK_COLORS[s.lock]} uiTransform={{ width: 36, height: 30 }} />
        )}
        <UiEntity uiTransform={{ flexGrow: 1 }} />
        <Btn label="Save" width={52} color={ACCENT} off={!s.dirty} onPress={() => act('edit_save')} />
        <Btn label="Revert" width={52} color={DANGER} off={!s.dirty} onPress={() => act('edit_revert')} />
        <Btn label="Done" width={52} onPress={() => act('edit_exit')} />
      </UiEntity>
    </UiEntity>
  )
}
