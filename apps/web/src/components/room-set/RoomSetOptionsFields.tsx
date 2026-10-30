'use client'
import type { RoomSetOptions, RoomStyle } from '@virvixr/shared'

export const ROOM_STYLES: Array<{ id: RoomStyle; label: string }> = [
  { id: 'plain', label: 'Plain' },
  { id: 'house', label: 'House' },
  { id: 'storefront', label: 'Storefront' },
  { id: 'dollhouse', label: 'Dollhouse' },
]

/**
 * A room set's look: exterior style, wall and floor colours, ceiling and furniture blocks. Shared by the wizard,
 * the asset library's "Make an asset from a room scan" and the scene page's Room set panel.
 */
export function RoomSetOptionsFields({ options: o, onChange, disabled = false }: {
  options: RoomSetOptions
  onChange: (changes: Partial<RoomSetOptions>) => void
  disabled?: boolean
}) {
  return (
    <div className="space-y-3">
      <label className="flex items-center justify-between gap-3 text-gray-300">
        Style
        <select value={o.style} onChange={(e) => onChange({ style: e.target.value as RoomStyle })} aria-label="Room style" disabled={disabled}
          className="rounded-md border border-gray-800 bg-gray-900 px-2 py-1.5 text-white outline-none focus:border-blue-400 disabled:opacity-50">
          {ROOM_STYLES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
      </label>
      <div className="flex flex-wrap gap-4 text-gray-300">
        <label className="flex items-center gap-2">
          <input type="color" value={o.wallColor} onChange={(e) => onChange({ wallColor: e.target.value.toUpperCase() })} aria-label="Wall colour" disabled={disabled}
            className="h-7 w-9 cursor-pointer rounded border border-gray-700 bg-transparent disabled:cursor-default disabled:opacity-50" />
          Walls
        </label>
        <label className="flex items-center gap-2">
          <input type="color" value={o.floorColor} onChange={(e) => onChange({ floorColor: e.target.value.toUpperCase() })} aria-label="Floor colour" disabled={disabled}
            className="h-7 w-9 cursor-pointer rounded border border-gray-700 bg-transparent disabled:cursor-default disabled:opacity-50" />
          Floor
        </label>
      </div>
      <div className="flex flex-wrap gap-4 text-gray-200">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={o.ceiling} onChange={(e) => onChange({ ceiling: e.target.checked })} disabled={disabled} />
          Ceiling
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={o.furniture} onChange={(e) => onChange({ furniture: e.target.checked })} disabled={disabled} />
          Furniture blocks
        </label>
      </div>
    </div>
  )
}
