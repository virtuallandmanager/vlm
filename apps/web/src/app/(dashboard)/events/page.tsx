'use client'
import { useApi } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useSearchParams, useRouter } from 'next/navigation'
import { useEffect, useState, Suspense } from 'react'

export default function EventsPage() {
  return (
    <Suspense fallback={<p className="text-gray-400">Loading...</p>}>
      <EventsContent />
    </Suspense>
  )
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatDateTime(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

// ── Main Content ─────────────────────────────────────────────────────────────

function EventsContent() {
  const { token } = useAuth()
  const api = useApi()
  const searchParams = useSearchParams()
  const router = useRouter()
  const selectedEventId = searchParams.get('id')

  const [events, setEvents] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)

  // create form
  const [newName, setNewName] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [newStart, setNewStart] = useState('')
  const [newEnd, setNewEnd] = useState('')
  const [newTz, setNewTz] = useState('UTC')

  useEffect(() => {
    if (!token) return
    api
      .getEvents()
      .then((data) => {
        setEvents(data.events)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [token])

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newName.trim()) return
    const { event } = await api.createEvent({
      name: newName.trim(),
      description: newDesc.trim() || undefined,
      startTime: newStart || undefined,
      endTime: newEnd || undefined,
      timezone: newTz || 'UTC',
    })
    setEvents((prev) => [event, ...prev])
    setNewName('')
    setNewDesc('')
    setNewStart('')
    setNewEnd('')
    setNewTz('UTC')
    setShowCreate(false)
  }

  // ── Detail view ────────────────────────────────────────────────────────────
  if (selectedEventId) {
    return (
      <div>
        <button
          onClick={() => router.push('/events')}
          className="mb-4 text-sm text-gray-400 hover:text-white"
        >
          &larr; Back to events
        </button>
        <EventDetail
          eventId={selectedEventId}
          onDeleted={() => {
            setEvents((prev) => prev.filter((e) => e.id !== selectedEventId))
            router.push('/events')
          }}
        />
      </div>
    )
  }

  // ── List view ──────────────────────────────────────────────────────────────
  if (loading) return <p className="text-gray-400">Loading events...</p>

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Events</h1>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-700"
        >
          + Create Event
        </button>
      </div>

      {showCreate && (
        <form onSubmit={handleCreate} className="mb-6 space-y-3 rounded-xl border border-gray-800 bg-gray-900 p-4">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Event name"
            autoFocus
            className="w-full rounded-lg bg-gray-800 px-4 py-2 text-white outline-none focus:ring-2 focus:ring-blue-500"
          />
          <input
            type="text"
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
            placeholder="Description (optional)"
            className="w-full rounded-lg bg-gray-800 px-4 py-2 text-white outline-none focus:ring-2 focus:ring-blue-500"
          />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Start time</label>
              <input
                type="datetime-local"
                value={newStart}
                onChange={(e) => setNewStart(e.target.value)}
                className="w-full rounded-lg bg-gray-800 px-4 py-2 text-white outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">End time</label>
              <input
                type="datetime-local"
                value={newEnd}
                onChange={(e) => setNewEnd(e.target.value)}
                className="w-full rounded-lg bg-gray-800 px-4 py-2 text-white outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Timezone</label>
              <input
                type="text"
                value={newTz}
                onChange={(e) => setNewTz(e.target.value)}
                placeholder="UTC"
                className="w-full rounded-lg bg-gray-800 px-4 py-2 text-white outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>
          <div className="flex gap-2">
            <button type="submit" className="rounded-lg bg-blue-600 px-4 py-2 text-sm hover:bg-blue-700">
              Create
            </button>
            <button
              type="button"
              onClick={() => setShowCreate(false)}
              className="rounded-lg bg-gray-800 px-4 py-2 text-sm hover:bg-gray-700"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {events.length === 0 ? (
        <p className="text-gray-500">No events yet. Create one to get started.</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {events.map((evt) => (
            <button
              key={evt.id}
              onClick={() => router.push(`/events?id=${evt.id}`)}
              className="rounded-xl border border-gray-800 bg-gray-900 p-4 hover:border-gray-600 transition-colors text-left"
            >
              <h3 className="font-semibold">{evt.name}</h3>
              <p className="mt-1 text-sm text-gray-400">{evt.description || 'No description'}</p>
              <div className="mt-2 text-xs text-gray-500 space-y-0.5">
                <p>Start: {formatDateTime(evt.startTime)}</p>
                <p>End: {formatDateTime(evt.endTime)}</p>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Event Detail ─────────────────────────────────────────────────────────────

function EventDetail({ eventId, onDeleted }: { eventId: string; onDeleted: () => void }) {
  const { token } = useAuth()
  const api = useApi()

  const [event, setEvent] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // edit form
  const [editName, setEditName] = useState('')
  const [editDesc, setEditDesc] = useState('')
  const [editStart, setEditStart] = useState('')
  const [editEnd, setEditEnd] = useState('')
  const [editTz, setEditTz] = useState('')
  const [saving, setSaving] = useState(false)

  // scenes
  const [allScenes, setAllScenes] = useState<any[]>([])
  const [linkSceneId, setLinkSceneId] = useState('')
  const [linking, setLinking] = useState(false)

  // delete
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    if (!token) return
    loadEvent()
    api.getScenes().then((d) => setAllScenes(d.scenes)).catch(() => {})
  }, [token, eventId])

  async function loadEvent() {
    setLoading(true)
    try {
      const { event: ev } = await api.getEvent(eventId)
      setEvent(ev)
      setEditName(ev.name)
      setEditDesc(ev.description || '')
      setEditStart(ev.startTime ? toLocalInput(ev.startTime) : '')
      setEditEnd(ev.endTime ? toLocalInput(ev.endTime) : '')
      setEditTz(ev.timezone || 'UTC')
    } catch {
      setError('Failed to load event')
    }
    setLoading(false)
  }

  function toLocalInput(iso: string) {
    const d = new Date(iso)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  const handleUpdate = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    try {
      const { event: updated } = await api.updateEvent(eventId, {
        name: editName.trim(),
        description: editDesc.trim(),
        startTime: editStart ? new Date(editStart).toISOString() : undefined,
        endTime: editEnd ? new Date(editEnd).toISOString() : undefined,
        timezone: editTz,
      })
      setEvent((prev: any) => ({ ...prev, ...updated }))
    } catch {
      setError('Failed to save')
    }
    setSaving(false)
  }

  const handleDelete = async () => {
    await api.deleteEvent(eventId)
    onDeleted()
  }

  const handleLinkScene = async () => {
    if (!linkSceneId) return
    setLinking(true)
    try {
      await api.linkSceneToEvent(eventId, linkSceneId)
      await loadEvent()
      setLinkSceneId('')
    } catch {
      setError('Failed to link scene')
    }
    setLinking(false)
  }

  const handleUnlinkScene = async (sceneId: string) => {
    try {
      await api.unlinkSceneFromEvent(eventId, sceneId)
      await loadEvent()
    } catch {
      setError('Failed to unlink scene')
    }
  }

  if (loading) return <p className="text-gray-400">Loading event...</p>
  if (error && !event) return <p className="text-red-400">{error}</p>
  if (!event) return <p className="text-gray-400">Event not found.</p>

  const linkedSceneIds = new Set(
    (event.sceneLinks || []).map((l: any) => l.sceneId)
  )
  const availableScenes = allScenes.filter((s) => !linkedSceneIds.has(s.id))

  return (
    <div className="space-y-6">
      {error && <p className="text-sm text-red-400">{error}</p>}

      {/* Edit form */}
      <form onSubmit={handleUpdate} className="space-y-3 rounded-xl border border-gray-800 bg-gray-900 p-4">
        <h2 className="text-lg font-semibold">Edit Event</h2>
        <input
          type="text"
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          placeholder="Event name"
          className="w-full rounded-lg bg-gray-800 px-4 py-2 text-white outline-none focus:ring-2 focus:ring-blue-500"
        />
        <input
          type="text"
          value={editDesc}
          onChange={(e) => setEditDesc(e.target.value)}
          placeholder="Description"
          className="w-full rounded-lg bg-gray-800 px-4 py-2 text-white outline-none focus:ring-2 focus:ring-blue-500"
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <label className="block text-xs text-gray-400 mb-1">Start time</label>
            <input
              type="datetime-local"
              value={editStart}
              onChange={(e) => setEditStart(e.target.value)}
              className="w-full rounded-lg bg-gray-800 px-4 py-2 text-white outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">End time</label>
            <input
              type="datetime-local"
              value={editEnd}
              onChange={(e) => setEditEnd(e.target.value)}
              className="w-full rounded-lg bg-gray-800 px-4 py-2 text-white outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Timezone</label>
            <input
              type="text"
              value={editTz}
              onChange={(e) => setEditTz(e.target.value)}
              className="w-full rounded-lg bg-gray-800 px-4 py-2 text-white outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>
        <button
          type="submit"
          disabled={saving}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm hover:bg-blue-700 disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
      </form>

      {/* Linked scenes */}
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-4">
        <h2 className="text-lg font-semibold mb-3">Linked Scenes</h2>
        {(event.sceneLinks || []).length === 0 ? (
          <p className="text-sm text-gray-500">No scenes linked to this event.</p>
        ) : (
          <ul className="space-y-2 mb-4">
            {(event.sceneLinks || []).map((link: any) => (
              <li key={link.sceneId} className="flex items-center justify-between rounded-lg bg-gray-800 px-3 py-2">
                <span className="text-sm">{link.scene?.name || link.sceneId}</span>
                <button
                  onClick={() => handleUnlinkScene(link.sceneId)}
                  className="text-xs text-red-400 hover:text-red-300"
                >
                  Unlink
                </button>
              </li>
            ))}
          </ul>
        )}

        {availableScenes.length > 0 && (
          <div className="flex gap-2">
            <select
              value={linkSceneId}
              onChange={(e) => setLinkSceneId(e.target.value)}
              className="flex-1 rounded-lg bg-gray-800 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">Select a scene to link...</option>
              {availableScenes.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <button
              onClick={handleLinkScene}
              disabled={!linkSceneId || linking}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm hover:bg-blue-700 disabled:opacity-50"
            >
              {linking ? 'Linking...' : 'Link Scene'}
            </button>
          </div>
        )}
      </div>

      {/* Delete */}
      <div className="rounded-xl border border-red-900/50 bg-gray-900 p-4">
        <h2 className="text-lg font-semibold text-red-400 mb-2">Danger Zone</h2>
        {!confirmDelete ? (
          <button
            onClick={() => setConfirmDelete(true)}
            className="rounded-lg bg-red-600/20 px-4 py-2 text-sm text-red-400 hover:bg-red-600/30"
          >
            Delete Event
          </button>
        ) : (
          <div className="flex items-center gap-3">
            <p className="text-sm text-gray-400">Are you sure? This cannot be undone.</p>
            <button
              onClick={handleDelete}
              className="rounded-lg bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700"
            >
              Confirm Delete
            </button>
            <button
              onClick={() => setConfirmDelete(false)}
              className="rounded-lg bg-gray-800 px-4 py-2 text-sm hover:bg-gray-700"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
