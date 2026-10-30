'use client'
import type { Dispatch } from 'react'
import type { RoomStyle } from '@virvixr/shared'
import type { WizardAction, WizardState } from '@/lib/wizard/state'
import type { RoomSetPreview } from '../useRoomSetPreview'

const STYLES: Array<{ id: RoomStyle; label: string }> = [
  { id: 'plain', label: 'Plain' },
  { id: 'house', label: 'House' },
  { id: 'storefront', label: 'Storefront' },
  { id: 'dollhouse', label: 'Dollhouse' },
]

export function ArrangeStep({ state, dispatch, roomPreview, selectedKey, setSelectedKey, moveSpawn, setMoveSpawn }: {
  state: WizardState
  dispatch: Dispatch<WizardAction>
  roomPreview: RoomSetPreview
  selectedKey: string | null
  setSelectedKey: (k: string | null) => void
  moveSpawn: boolean
  setMoveSpawn: (v: boolean) => void
}) {
  const selected = state.items.find((i) => i.key === selectedKey) ?? null
  return (
    <div className="space-y-4 text-sm">
      {state.roomSet && <RoomSetControls roomSet={state.roomSet} dispatch={dispatch} preview={roomPreview} />}
      <p className="text-gray-300">
        Drag things around the preview and turn them. They stay on the ground and inside the plot. This is a rough layout:
        exact placement happens in-world, with the Virvi editor, once you&apos;re standing in it.
      </p>
      <label className="flex items-center gap-2 text-gray-200">
        <input type="checkbox" checked={moveSpawn} onChange={(e) => setMoveSpawn(e.target.checked)} />
        Move the arrival point
      </label>
      {moveSpawn && <p className="text-xs text-gray-500">Drag the green marker to where people should arrive.</p>}
      {selected ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-gray-800 bg-gray-950 px-3 py-2">
          <span className="mr-auto truncate text-gray-200">{selected.asset.name}</span>
          <button type="button" onClick={() => dispatch({ type: 'rotateItem', key: selected.key })} className="rounded bg-gray-800 px-2.5 py-1 hover:bg-gray-700">Turn 90°</button>
          <button type="button" onClick={() => { dispatch({ type: 'removeItem', key: selected.key }); setSelectedKey(null) }}
            className="rounded px-2.5 py-1 text-red-300 hover:bg-white/5">Remove</button>
        </div>
      ) : (
        state.items.length > 0 && <p className="text-xs text-gray-500">Click an item in the preview to select it.</p>
      )}
    </div>
  )
}

/** The room set's look: style, wall and floor colours, ceiling and furniture blocks. The preview follows each change. */
function RoomSetControls({ roomSet, dispatch, preview }: {
  roomSet: NonNullable<WizardState['roomSet']>
  dispatch: Dispatch<WizardAction>
  preview: RoomSetPreview
}) {
  const o = roomSet.options
  const set = (options: Partial<typeof o>) => dispatch({ type: 'setRoomSetOptions', options })
  return (
    <fieldset className="space-y-3 rounded-md border border-gray-800 bg-gray-950 p-3">
      <legend className="px-1 text-gray-200">Your room</legend>
      <label className="flex items-center justify-between gap-3 text-gray-300">
        Style
        <select value={o.style} onChange={(e) => set({ style: e.target.value as RoomStyle })} aria-label="Room style"
          className="rounded-md border border-gray-800 bg-gray-900 px-2 py-1.5 text-white outline-none focus:border-blue-400">
          {STYLES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
      </label>
      <div className="flex flex-wrap gap-4 text-gray-300">
        <label className="flex items-center gap-2">
          <input type="color" value={o.wallColor} onChange={(e) => set({ wallColor: e.target.value.toUpperCase() })} aria-label="Wall colour"
            className="h-7 w-9 cursor-pointer rounded border border-gray-700 bg-transparent" />
          Walls
        </label>
        <label className="flex items-center gap-2">
          <input type="color" value={o.floorColor} onChange={(e) => set({ floorColor: e.target.value.toUpperCase() })} aria-label="Floor colour"
            className="h-7 w-9 cursor-pointer rounded border border-gray-700 bg-transparent" />
          Floor
        </label>
      </div>
      <div className="flex flex-wrap gap-4 text-gray-200">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={o.ceiling} onChange={(e) => set({ ceiling: e.target.checked })} />
          Ceiling
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={o.furniture} onChange={(e) => set({ furniture: e.target.checked })} />
          Furniture blocks
        </label>
      </div>
      {preview.loading && <p className="text-xs text-gray-500" role="status">Building the preview…</p>}
      {preview.error && <p className="text-xs text-red-300" role="alert">{preview.error}</p>}
    </fieldset>
  )
}
