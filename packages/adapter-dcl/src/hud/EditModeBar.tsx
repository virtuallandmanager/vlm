// Floating bar for in-world transform editing: mode buttons, the selected item, Move's axis lock, Save / Revert / Done,
// the held / error message, the "Save or revert first" prompt and the Exact panel (type X / Y / Z for the current mode). Rendered by DclHUDRenderer from its module state.
import ReactEcs, { UiEntity, Label, Input } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { markHudPress } from './press.js'
import type { Axis, MoveLock, TransformMode } from '@virvixr/core'
import type { Vec3 } from '@virvixr/shared'

export interface EditModeHUDState {
  active: boolean
  mode: TransformMode
  lock: MoveLock
  selectedName: string | null
  dirty: boolean
  message: string | null
  prompt: boolean
  saving: boolean
  values: Vec3 | null
}

export const NO_EDIT_MODE: EditModeHUDState = {
  active: false, mode: 'move', lock: 'free', selectedName: null, dirty: false, message: null, prompt: false, saving: false, values: null,
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
const EXACT_H = 70
const AXES: Axis[] = ['x', 'y', 'z']
const EXACT_TITLE: Record<TransformMode, string> = { move: 'Position (m)', rotate: 'Rotation (degrees)', resize: 'Scale' }

// The Exact panel's state lives here: whether it's open, and text typed but not applied yet (per axis). Typed text is
// dropped when the selection or mode changes; until then a field shows it instead of the live value.
let exactOpen = false
let typed: Partial<Record<Axis, string>> = {}
let typedFor = ''

const fmt = (n: number) => String(Math.round(n * 1000) / 1000)
/** A typed number, or null for anything else (empty, "1abc"). */
export function parseExact(text: string): number | null {
  const t = text.trim()
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

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

function ExactPanel({ s, act }: { s: EditModeHUDState; act: Act }) {
  const values = s.values!
  const apply = (axis: Axis) => {
    const text = typed[axis]
    if (text === undefined) return
    delete typed[axis]
    const n = parseExact(text)
    if (n !== null) act('edit_value', { axis, value: n }) // anything else: the field shows the old value again
  }
  return (
    <UiEntity
      uiTransform={{ width: BAR_W, height: EXACT_H, margin: { bottom: 4 }, flexDirection: 'column', padding: { left: 12, right: 12, top: 6 } }}
      uiBackground={{ color: BG }}
      onMouseDown={markHudPress}
    >
      <Label value={`${EXACT_TITLE[s.mode]} — type a value and press Enter`} fontSize={10} color={DIM} textAlign="middle-left" uiTransform={{ height: 18 }} />
      <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', height: 40 }}>
        {AXES.map((axis) => (
          <UiEntity key={axis} uiTransform={{ flexDirection: 'row', alignItems: 'center', margin: { right: 14 } }}>
            <Label value={axis.toUpperCase()} fontSize={12} color={LOCK_COLORS[axis]} uiTransform={{ width: 16, height: 36 }} />
            <Input
              uiTransform={{ width: 120, height: 36 }}
              uiBackground={{ color: BTN }}
              color={WHITE}
              placeholderColor={DIM}
              placeholder={fmt(values[axis])}
              fontSize={12}
              value={typed[axis] ?? fmt(values[axis])}
              onChange={(v) => { typed[axis] = v }}
              onSubmit={() => apply(axis)}
            />
          </UiEntity>
        ))}
        <UiEntity uiTransform={{ flexGrow: 1 }} />
        <Btn label="Apply" width={64} color={ACCENT} off={s.saving} onPress={() => AXES.forEach(apply)} />
      </UiEntity>
    </UiEntity>
  )
}

export function EditModeBar({ s, act }: { s: EditModeHUDState; act: Act }) {
  const name = s.selectedName ?? 'this item'
  const forKey = `${s.selectedName}:${s.mode}`
  if (forKey !== typedFor) {
    typedFor = forKey
    typed = {}
  }
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
            <Btn label="Save" width={80} color={ACCENT} off={s.saving} onPress={() => act('edit_save')} />
            <Btn label="Revert" width={80} color={DANGER} off={s.saving} onPress={() => act('edit_revert')} />
          </UiEntity>
        </UiEntity>
      )}
      {exactOpen && s.values && <ExactPanel s={s} act={act} />}
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
          uiTransform={{ width: 130, height: 30, margin: { left: 6, right: 6 } }}
        />
        {s.mode === 'move' && (
          <Label value={s.lock === 'free' ? 'Free' : s.lock.toUpperCase()} fontSize={12} color={LOCK_COLORS[s.lock]} uiTransform={{ width: 36, height: 30 }} />
        )}
        <UiEntity uiTransform={{ flexGrow: 1 }} />
        <Btn label="Exact" width={52} color={exactOpen ? ACCENT : BTN} off={!s.values} onPress={() => { exactOpen = !exactOpen }} />
        <Btn label="Save" width={52} color={ACCENT} off={!s.dirty || s.saving} onPress={() => act('edit_save')} />
        <Btn label="Revert" width={52} color={DANGER} off={!s.dirty || s.saving} onPress={() => act('edit_revert')} />
        <Btn label="Done" width={52} onPress={() => act('edit_exit')} />
      </UiEntity>
    </UiEntity>
  )
}
