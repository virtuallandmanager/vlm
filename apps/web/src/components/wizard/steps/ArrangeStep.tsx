'use client'
import type { Dispatch } from 'react'
import type { WizardAction, WizardState } from '@/lib/wizard/state'

export function ArrangeStep({ state, dispatch, selectedKey, setSelectedKey, moveSpawn, setMoveSpawn }: {
  state: WizardState
  dispatch: Dispatch<WizardAction>
  selectedKey: string | null
  setSelectedKey: (k: string | null) => void
  moveSpawn: boolean
  setMoveSpawn: (v: boolean) => void
}) {
  const selected = state.items.find((i) => i.key === selectedKey) ?? null
  return (
    <div className="space-y-4 text-sm">
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
