'use client'
import { useApi } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useSearchParams, useRouter } from 'next/navigation'
import { useEffect, useState, Suspense } from 'react'

export default function StreamingPage() {
  return (
    <Suspense fallback={<p className="text-gray-400">Loading...</p>}>
      <StreamingContent />
    </Suspense>
  )
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const statusColors: Record<string, string> = {
  ready: 'bg-green-500',
  live: 'bg-green-400 animate-pulse',
  provisioning: 'bg-yellow-500',
  error: 'bg-red-500',
  terminated: 'bg-red-500',
  offline: 'bg-gray-500',
}

const statusLabels: Record<string, string> = {
  ready: 'Ready',
  live: 'Live',
  provisioning: 'Provisioning',
  error: 'Error',
  terminated: 'Terminated',
  offline: 'Offline',
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium">
      <span className={`inline-block h-2 w-2 rounded-full ${statusColors[status] || 'bg-gray-500'}`} />
      {statusLabels[status] || status}
    </span>
  )
}

function formatDateTime(iso: string | null) {
  if (!iso) return '--'
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

function formatDuration(seconds: number | null) {
  if (!seconds) return '--'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <button
      onClick={handleCopy}
      className="rounded bg-gray-700 px-2 py-1 text-xs text-gray-300 hover:bg-gray-600 hover:text-white transition-colors"
    >
      {copied ? 'Copied!' : label || 'Copy'}
    </button>
  )
}

function RevealableField({ value, label }: { value: string; label: string }) {
  const [revealed, setRevealed] = useState(false)

  return (
    <div>
      <p className="text-xs text-gray-400 mb-1">{label}</p>
      <div className="flex items-center gap-2">
        <code className="flex-1 rounded bg-gray-800 px-3 py-1.5 text-sm font-mono text-gray-300 truncate">
          {revealed ? value : '\u2022'.repeat(Math.min(value.length, 32))}
        </code>
        <button
          onClick={() => setRevealed(!revealed)}
          className="rounded bg-gray-700 px-2 py-1 text-xs text-gray-300 hover:bg-gray-600 hover:text-white"
        >
          {revealed ? 'Hide' : 'Reveal'}
        </button>
        <CopyButton text={value} />
      </div>
    </div>
  )
}

// ── Main Content ─────────────────────────────────────────────────────────────

function StreamingContent() {
  const { token } = useAuth()
  const api = useApi()
  const searchParams = useSearchParams()
  const router = useRouter()
  const selectedServerId = searchParams.get('id')

  const [servers, setServers] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [showProvision, setShowProvision] = useState(false)

  // provision form
  const [newName, setNewName] = useState('')
  const [newType, setNewType] = useState<'shared' | 'dedicated'>('shared')
  const [newRegion, setNewRegion] = useState('us-east-1')
  const [provisioning, setProvisioning] = useState(false)
  const [provisionError, setProvisionError] = useState('')

  useEffect(() => {
    if (!token) return
    api
      .getStreamingServers()
      .then((data) => {
        setServers(data.servers)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [token])

  const handleProvision = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newName.trim()) return
    setProvisioning(true)
    setProvisionError('')
    try {
      const { server } = await api.provisionStreamingServer({
        name: newName.trim(),
        type: newType,
        region: newRegion.trim() || undefined,
      })
      setServers((prev) => [server, ...prev])
      setNewName('')
      setNewType('shared')
      setNewRegion('us-east-1')
      setShowProvision(false)
    } catch (err: any) {
      setProvisionError(err.message || 'Failed to provision server')
    }
    setProvisioning(false)
  }

  // ── Detail view ────────────────────────────────────────────────────────────
  if (selectedServerId) {
    return (
      <div>
        <button
          onClick={() => router.push('/streaming')}
          className="mb-4 text-sm text-gray-400 hover:text-white"
        >
          &larr; Back to servers
        </button>
        <ServerDetail
          serverId={selectedServerId}
          onDeleted={() => {
            setServers((prev) => prev.filter((s) => s.id !== selectedServerId))
            router.push('/streaming')
          }}
        />
      </div>
    )
  }

  // ── List view ──────────────────────────────────────────────────────────────
  if (loading) return <p className="text-gray-400">Loading streaming servers...</p>

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Streaming</h1>
        <button
          onClick={() => setShowProvision(!showProvision)}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-700"
        >
          + Provision Server
        </button>
      </div>

      {showProvision && (
        <form onSubmit={handleProvision} className="mb-6 space-y-3 rounded-xl border border-gray-800 bg-gray-900 p-4">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Server name"
            autoFocus
            className="w-full rounded-lg bg-gray-800 px-4 py-2 text-white outline-none focus:ring-2 focus:ring-blue-500"
          />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Type</label>
              <select
                value={newType}
                onChange={(e) => setNewType(e.target.value as 'shared' | 'dedicated')}
                className="w-full rounded-lg bg-gray-800 px-4 py-2 text-white outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="shared">Shared</option>
                <option value="dedicated">Dedicated</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Region</label>
              <input
                type="text"
                value={newRegion}
                onChange={(e) => setNewRegion(e.target.value)}
                placeholder="us-east-1"
                className="w-full rounded-lg bg-gray-800 px-4 py-2 text-white outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>
          {provisionError && <p className="text-sm text-red-400">{provisionError}</p>}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={provisioning}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm hover:bg-blue-700 disabled:opacity-50"
            >
              {provisioning ? 'Provisioning...' : 'Provision'}
            </button>
            <button
              type="button"
              onClick={() => setShowProvision(false)}
              className="rounded-lg bg-gray-800 px-4 py-2 text-sm hover:bg-gray-700"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {servers.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-gray-500 mb-2">No streaming servers yet.</p>
          <p className="text-sm text-gray-600">Provision a server to start streaming via RTMP.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {servers.map((srv) => (
            <ServerCard key={srv.id} server={srv} onClick={() => router.push(`/streaming?id=${srv.id}`)} />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Server Card ──────────────────────────────────────────────────────────────

function ServerCard({ server, onClick }: { server: any; onClick: () => void }) {
  const [keyRevealed, setKeyRevealed] = useState(false)

  return (
    <button
      onClick={onClick}
      className="rounded-xl border border-gray-800 bg-gray-900 p-4 hover:border-gray-600 transition-colors text-left w-full"
    >
      <div className="flex items-start justify-between mb-2">
        <h3 className="font-semibold truncate mr-2">{server.name}</h3>
        <StatusBadge status={server.status} />
      </div>

      <div className="space-y-1.5 text-sm">
        <div className="flex items-center gap-2">
          <span className="text-gray-500 text-xs w-14 shrink-0">Type</span>
          <span className="text-gray-300 capitalize">{server.type}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-gray-500 text-xs w-14 shrink-0">Region</span>
          <span className="text-gray-300">{server.region || '--'}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-gray-500 text-xs w-14 shrink-0">RTMP</span>
          <span className="text-gray-300 font-mono text-xs truncate">{server.rtmpUrl || '--'}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-gray-500 text-xs w-14 shrink-0">Key</span>
          <span
            className="text-gray-300 font-mono text-xs truncate cursor-pointer"
            onClick={(e) => {
              e.stopPropagation()
              setKeyRevealed(!keyRevealed)
            }}
          >
            {keyRevealed ? server.streamKey : '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022 (click to reveal)'}
          </span>
        </div>
      </div>
    </button>
  )
}

// ── Server Detail ────────────────────────────────────────────────────────────

function ServerDetail({ serverId, onDeleted }: { serverId: string; onDeleted: () => void }) {
  const { token } = useAuth()
  const api = useApi()

  const [server, setServer] = useState<any>(null)
  const [sessions, setSessions] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    if (!token) return
    loadData()
  }, [token, serverId])

  async function loadData() {
    setLoading(true)
    try {
      const [serverRes, sessionsRes] = await Promise.all([
        api.getStreamingServer(serverId),
        api.getStreamingSessions(serverId),
      ])
      setServer(serverRes.server)
      setSessions(sessionsRes.sessions)
    } catch {
      setError('Failed to load server details')
    }
    setLoading(false)
  }

  const handleDelete = async () => {
    setDeleting(true)
    try {
      await api.deleteStreamingServer(serverId)
      onDeleted()
    } catch {
      setError('Failed to delete server')
      setDeleting(false)
    }
  }

  if (loading) return <p className="text-gray-400">Loading server details...</p>
  if (error && !server) return <p className="text-red-400">{error}</p>
  if (!server) return <p className="text-gray-400">Server not found.</p>

  return (
    <div className="space-y-6">
      {error && <p className="text-sm text-red-400">{error}</p>}

      {/* Server Info */}
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-xl font-semibold">{server.name}</h2>
            <p className="text-sm text-gray-400 mt-1 capitalize">{server.type} server</p>
          </div>
          <StatusBadge status={server.status} />
        </div>

        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <p className="text-xs text-gray-400 mb-1">Region</p>
              <p className="text-sm text-gray-200">{server.region || '--'}</p>
            </div>
            <div>
              <p className="text-xs text-gray-400 mb-1">Created</p>
              <p className="text-sm text-gray-200">{formatDateTime(server.createdAt)}</p>
            </div>
            {server.sceneId && (
              <div>
                <p className="text-xs text-gray-400 mb-1">Linked Scene</p>
                <p className="text-sm text-gray-200 font-mono">{server.sceneId}</p>
              </div>
            )}
            {server.infrastructureId && (
              <div>
                <p className="text-xs text-gray-400 mb-1">Infrastructure ID</p>
                <p className="text-sm text-gray-200 font-mono truncate">{server.infrastructureId}</p>
              </div>
            )}
          </div>

          <div>
            <p className="text-xs text-gray-400 mb-1">RTMP URL</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded bg-gray-800 px-3 py-1.5 text-sm font-mono text-gray-300 truncate">
                {server.rtmpUrl || '--'}
              </code>
              {server.rtmpUrl && <CopyButton text={server.rtmpUrl} />}
            </div>
          </div>

          {server.streamKey && (
            <RevealableField value={server.streamKey} label="Stream Key" />
          )}

          {server.hlsPlaylistUrl && (
            <div>
              <p className="text-xs text-gray-400 mb-1">HLS Playlist URL</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded bg-gray-800 px-3 py-1.5 text-sm font-mono text-gray-300 truncate">
                  {server.hlsPlaylistUrl}
                </code>
                <CopyButton text={server.hlsPlaylistUrl} />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Sessions History */}
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
        <h2 className="text-lg font-semibold mb-3">Sessions History</h2>
        {sessions.length === 0 ? (
          <p className="text-sm text-gray-500">No sessions recorded yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 text-left text-xs text-gray-400">
                  <th className="pb-2 pr-4 font-medium">Started</th>
                  <th className="pb-2 pr-4 font-medium">Ended</th>
                  <th className="pb-2 pr-4 font-medium">Duration</th>
                  <th className="pb-2 pr-4 font-medium">Peak Bitrate</th>
                  <th className="pb-2 pr-4 font-medium">Peak Viewers</th>
                  <th className="pb-2 font-medium">Recorded</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/50">
                {sessions.map((session) => (
                  <tr key={session.id} className="text-gray-300">
                    <td className="py-2 pr-4 whitespace-nowrap">{formatDateTime(session.startedAt)}</td>
                    <td className="py-2 pr-4 whitespace-nowrap">{formatDateTime(session.endedAt)}</td>
                    <td className="py-2 pr-4 whitespace-nowrap">{formatDuration(session.durationSeconds)}</td>
                    <td className="py-2 pr-4 whitespace-nowrap">
                      {session.peakBitrate ? `${session.peakBitrate} kbps` : '--'}
                    </td>
                    <td className="py-2 pr-4 whitespace-nowrap">{session.peakViewers ?? '--'}</td>
                    <td className="py-2 whitespace-nowrap">
                      {session.recorded ? (
                        <span className="inline-flex items-center rounded-full bg-blue-500/20 px-2 py-0.5 text-xs text-blue-400">
                          Recorded
                        </span>
                      ) : (
                        <span className="text-gray-500">--</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Delete */}
      <div className="rounded-xl border border-red-900/50 bg-gray-900 p-4">
        <h2 className="text-lg font-semibold text-red-400 mb-2">Danger Zone</h2>
        <p className="text-sm text-gray-400 mb-3">
          Terminating this server will stop all active streams and mark it as terminated.
        </p>
        {!confirmDelete ? (
          <button
            onClick={() => setConfirmDelete(true)}
            className="rounded-lg bg-red-600/20 px-4 py-2 text-sm text-red-400 hover:bg-red-600/30"
          >
            Terminate Server
          </button>
        ) : (
          <div className="flex items-center gap-3">
            <p className="text-sm text-gray-400">Are you sure? This cannot be undone.</p>
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="rounded-lg bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700 disabled:opacity-50"
            >
              {deleting ? 'Terminating...' : 'Confirm Terminate'}
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
