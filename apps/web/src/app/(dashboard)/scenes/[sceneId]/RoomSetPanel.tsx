'use client'
import { useEffect, useState } from 'react'
import type { RoomSetOptions } from '@virvixr/shared'
import { useApi, type RoomSetDetail } from '@/lib/api'
import { errorCode } from '@/lib/wizard/run'
import { MOVE_STEP_M, nudgesFor, roomSetErrorMessage, SCAN_DELETED_MESSAGE, stepNudge, TURN_STEP_DEG, type RoomNudge } from '@/lib/room-set'
import { RoomSetOptionsFields } from '@/components/room-set/RoomSetOptionsFields'

type Load = { state: 'loading' } | { state: 'ready'; set: RoomSetDetail } | { state: 'not_yours' } | { state: 'error'; message: string }

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const stepButton = 'h-7 w-7 rounded bg-gray-800 text-gray-200 hover:bg-gray-700 disabled:opacity-40'

/**
 * A scene's room set: restyle it, or nudge its rooms (to fix how separate captures line up) and snap their doors.
 * Saving regenerates this scene's GLB only; the element's model follows (`onSaved` gets the new URL).
 */
export function RoomSetPanel({ roomSetId, onSaved }: { roomSetId: string; onSaved: (modelSrc: string) => void }) {
  const api = useApi()
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [options, setOptions] = useState<RoomSetOptions | null>(null)
  const [nudges, setNudges] = useState<RoomNudge[]>([])
  const [adjusting, setAdjusting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null)

  const show = (set: RoomSetDetail) => {
    setLoad({ state: 'ready', set })
    setOptions(set.options)
    setNudges(nudgesFor(set.rooms?.length ?? 0, set.nudges))
  }

  useEffect(() => {
    api.getRoomSet(roomSetId).then(({ set }) => show(set), (err) => {
      setLoad(err?.status === 404 ? { state: 'not_yours' } : { state: 'error', message: roomSetErrorMessage(err) })
    })
  }, [roomSetId])

  if (load.state === 'loading') return <div className="h-24 animate-pulse rounded-md border border-gray-800 bg-gray-950" aria-hidden="true" />
  if (load.state === 'not_yours') {
    return <Frame><p className="text-xs text-gray-500">Only the person who scanned this room can restyle it.</p></Frame>
  }
  if (load.state === 'error') return <Frame><p className="text-xs text-red-300" role="alert">{load.message}</p></Frame>

  const { set } = load
  if (!set.rooms || !options) return <Frame><p className="text-xs text-gray-400">{SCAN_DELETED_MESSAGE}</p></Frame>
  const rooms = set.rooms
  const storedNudges = nudgesFor(rooms.length, set.nudges)
  const optionsChanged = !same(options, set.options)
  const nudgesChanged = !same(nudges, storedNudges)

  const save = async (snap: boolean) => {
    setSaving(true)
    setMessage(null)
    try {
      const { set: saved } = await api.updateRoomSet(set.id, {
        ...(optionsChanged ? { options } : {}),
        ...(nudgesChanged || snap ? { nudges } : {}),
        ...(snap ? { snap: true } : {}),
      })
      show({ ...saved, rooms })
      onSaved(saved.glbUrl)
      setMessage({ text: `${snap ? 'Doors snapped and saved' : 'Saved'}. A deployed World shows it after the next redeploy.`, error: false })
    } catch (err) {
      if (errorCode(err) === 'scan_deleted') show({ ...set, rooms: null })
      setMessage({ text: roomSetErrorMessage(err), error: true })
    } finally {
      setSaving(false)
    }
  }

  const nudge = (i: number, axis: keyof RoomNudge, dir: 1 | -1) =>
    setNudges((prev) => prev.map((n, j) => (j === i ? stepNudge(n, axis, dir) : n)))

  return (
    <Frame>
      <RoomSetOptionsFields options={options} onChange={(c) => setOptions((o) => (o ? { ...o, ...c } : o))} disabled={saving} />

      <div className="border-t border-gray-800 pt-3">
        <button type="button" onClick={() => setAdjusting((v) => !v)} aria-expanded={adjusting} className="text-sm text-blue-400 hover:text-blue-300">
          {adjusting ? 'Hide room adjustments' : 'Adjust rooms'}
        </button>
        {adjusting && (
          <div className="mt-3 space-y-3">
            <p className="text-xs text-gray-500">
              Move or turn a room to fix how separate captures line up. Each step is {MOVE_STEP_M * 100} cm or {TURN_STEP_DEG}°.
            </p>
            {rooms.map((label, i) => (
              <div key={i} className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <span className="w-28 truncate text-gray-200" title={label}>{label || `Room ${i + 1}`}</span>
                <Stepper label={`${label || `Room ${i + 1}`} east-west`} short="x" value={`${nudges[i].dx.toFixed(2)} m`} disabled={saving}
                  onStep={(dir) => nudge(i, 'dx', dir)} />
                <Stepper label={`${label || `Room ${i + 1}`} north-south`} short="z" value={`${nudges[i].dz.toFixed(2)} m`} disabled={saving}
                  onStep={(dir) => nudge(i, 'dz', dir)} />
                <Stepper label={`${label || `Room ${i + 1}`} turn`} short="turn" value={`${nudges[i].yaw}°`} disabled={saving}
                  onStep={(dir) => nudge(i, 'yaw', dir)} />
              </div>
            ))}
            {rooms.length > 1 && (
              <button type="button" onClick={() => save(true)} disabled={saving}
                className="rounded bg-gray-700 px-3 py-1.5 text-sm text-white hover:bg-gray-600 disabled:opacity-50">
                Snap doors
              </button>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => save(false)} disabled={saving || (!optionsChanged && !nudgesChanged)}
          className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50">
          {saving ? 'Saving…' : 'Save'}
        </button>
        {message && <p className={`text-xs ${message.error ? 'text-red-300' : 'text-green-400'}`} role={message.error ? 'alert' : 'status'}>{message.text}</p>}
      </div>
    </Frame>
  )
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <fieldset className="space-y-3 rounded-md border border-gray-800 bg-gray-950 p-3 text-sm">
      <legend className="px-1 text-gray-200">Room set</legend>
      {children}
    </fieldset>
  )
}

function Stepper({ label, short, value, disabled, onStep }: { label: string; short: string; value: string; disabled: boolean; onStep: (dir: 1 | -1) => void }) {
  return (
    <span className="flex items-center gap-1.5 text-xs text-gray-400">
      {short}
      <button type="button" className={stepButton} onClick={() => onStep(-1)} disabled={disabled} aria-label={`${label}: less`}>−</button>
      <span className="w-14 text-center font-mono text-gray-200">{value}</span>
      <button type="button" className={stepButton} onClick={() => onStep(1)} disabled={disabled} aria-label={`${label}: more`}>+</button>
    </span>
  )
}
