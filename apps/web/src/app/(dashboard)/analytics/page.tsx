'use client'
import { useApi } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useEffect, useState, useMemo, Suspense } from 'react'

export default function AnalyticsPage() {
  return (
    <Suspense fallback={<p className="text-gray-400">Loading...</p>}>
      <AnalyticsContent />
    </Suspense>
  )
}

type TimeRange = '24h' | '7d' | '30d' | 'all'

interface SessionWithActions {
  id: string
  displayName: string | null
  userId: string | null
  walletAddress: string | null
  platform: string | null
  startedAt: string
  endedAt: string | null
  actions: any[]
}

function AnalyticsContent() {
  const { token } = useAuth()
  const api = useApi()

  const [scenes, setScenes] = useState<any[]>([])
  const [selectedSceneId, setSelectedSceneId] = useState<string>('')
  const [timeRange, setTimeRange] = useState<TimeRange>('7d')
  const [sessions, setSessions] = useState<SessionWithActions[]>([])
  const [recentStats, setRecentStats] = useState<{
    visitors: number
    actions: number
    activeSessions: number
  } | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingSessions, setLoadingSessions] = useState(false)
  const [sortDesc, setSortDesc] = useState(true)

  // Load scenes list
  useEffect(() => {
    if (!token) return
    api.getScenes().then(data => {
      setScenes(data.scenes)
      if (data.scenes.length > 0) {
        setSelectedSceneId(data.scenes[0].id)
      }
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [token])

  // Load analytics when scene changes
  useEffect(() => {
    if (!selectedSceneId || !token) return
    setLoadingSessions(true)

    Promise.all([
      api.getSceneAnalyticsRecent(selectedSceneId),
      api.getSceneAnalyticsSessions(selectedSceneId, { limit: 200 }),
    ]).then(([recent, sessionsData]) => {
      setRecentStats({
        visitors: recent.visitors,
        actions: recent.actions,
        activeSessions: recent.activeSessions,
      })
      setSessions(sessionsData.sessions)
      setLoadingSessions(false)
    }).catch(() => {
      setLoadingSessions(false)
    })
  }, [selectedSceneId, token])

  // Filter sessions by time range
  const filteredSessions = useMemo(() => {
    if (timeRange === 'all') return sessions
    const now = Date.now()
    const ranges: Record<string, number> = {
      '24h': 24 * 60 * 60 * 1000,
      '7d': 7 * 24 * 60 * 60 * 1000,
      '30d': 30 * 24 * 60 * 60 * 1000,
    }
    const cutoff = now - ranges[timeRange]
    return sessions.filter(s => new Date(s.startedAt).getTime() >= cutoff)
  }, [sessions, timeRange])

  // Sort sessions
  const sortedSessions = useMemo(() => {
    return [...filteredSessions].sort((a, b) => {
      const diff = new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime()
      return sortDesc ? -diff : diff
    })
  }, [filteredSessions, sortDesc])

  // Compute derived stats
  const stats = useMemo(() => {
    const totalSessions = filteredSessions.length
    const uniqueVisitors = new Set(
      filteredSessions.map(s => s.walletAddress || s.userId || s.displayName || s.id)
    ).size
    const totalActions = filteredSessions.reduce((sum, s) => sum + (s.actions?.length || 0), 0)

    let totalDurationMs = 0
    let sessionsWithDuration = 0
    for (const s of filteredSessions) {
      if (s.endedAt) {
        totalDurationMs += new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime()
        sessionsWithDuration++
      }
    }
    const avgDurationSec = sessionsWithDuration > 0
      ? Math.round(totalDurationMs / sessionsWithDuration / 1000)
      : 0

    return { totalSessions, uniqueVisitors, totalActions, avgDurationSec }
  }, [filteredSessions])

  // Actions breakdown
  const actionsBreakdown = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const s of filteredSessions) {
      for (const a of s.actions || []) {
        counts[a.name] = (counts[a.name] || 0) + 1
      }
    }
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
  }, [filteredSessions])

  const maxActionCount = actionsBreakdown.length > 0 ? actionsBreakdown[0][1] : 0

  // Platform breakdown
  const platformBreakdown = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const s of filteredSessions) {
      const platform = s.platform || 'unknown'
      counts[platform] = (counts[platform] || 0) + 1
    }
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
  }, [filteredSessions])

  const maxPlatformCount = platformBreakdown.length > 0 ? platformBreakdown[0][1] : 0

  const platformColors: Record<string, string> = {
    decentraland: 'bg-red-500',
    hyperfy: 'bg-purple-500',
    oncyber: 'bg-cyan-500',
    secondlife: 'bg-green-500',
    unknown: 'bg-gray-500',
  }

  function formatDuration(seconds: number): string {
    if (seconds < 60) return `${seconds}s`
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    if (mins < 60) return `${mins}m ${secs}s`
    const hrs = Math.floor(mins / 60)
    return `${hrs}h ${mins % 60}m`
  }

  function sessionDuration(s: SessionWithActions): string {
    if (!s.endedAt) return 'Active'
    const ms = new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime()
    return formatDuration(Math.round(ms / 1000))
  }

  if (loading) return <p className="text-gray-400">Loading analytics...</p>

  if (scenes.length === 0) {
    return (
      <div>
        <h1 className="text-2xl font-bold mb-6">Analytics</h1>
        <div className="rounded-xl border border-gray-800 bg-gray-900 p-8 text-center">
          <p className="text-gray-400">No scenes found. Create a scene first to view analytics.</p>
        </div>
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Analytics</h1>
      </div>

      {/* Scene Selector + Time Range */}
      <div className="flex flex-wrap items-center gap-4 mb-6">
        <div>
          <label className="block text-xs text-gray-500 mb-1">Scene</label>
          <select
            value={selectedSceneId}
            onChange={e => setSelectedSceneId(e.target.value)}
            className="rounded-lg bg-gray-800 border border-gray-700 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-blue-500"
          >
            {scenes.map(scene => (
              <option key={scene.id} value={scene.id}>{scene.name}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs text-gray-500 mb-1">Time Range</label>
          <div className="flex rounded-lg overflow-hidden border border-gray-700">
            {([
              ['24h', 'Last 24h'],
              ['7d', '7 days'],
              ['30d', '30 days'],
              ['all', 'All time'],
            ] as [TimeRange, string][]).map(([value, label]) => (
              <button
                key={value}
                onClick={() => setTimeRange(value)}
                className={`px-3 py-2 text-sm ${
                  timeRange === value
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-800 text-gray-400 hover:text-white hover:bg-gray-700'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {loadingSessions ? (
        <p className="text-gray-400">Loading session data...</p>
      ) : (
        <>
          {/* Overview Cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
            <StatCard label="Total Sessions" value={stats.totalSessions} />
            <StatCard label="Unique Visitors" value={stats.uniqueVisitors} />
            <StatCard label="Avg Duration" value={formatDuration(stats.avgDurationSec)} />
            <StatCard label="Total Actions" value={stats.totalActions} />
          </div>

          {recentStats && (
            <div className="mb-8 rounded-xl border border-gray-800 bg-gray-900 p-4">
              <h2 className="text-sm font-semibold text-gray-400 mb-2">Live (Last 24h from server)</h2>
              <div className="flex gap-6 text-sm">
                <span className="text-white">{recentStats.activeSessions} <span className="text-gray-500">active now</span></span>
                <span className="text-white">{recentStats.visitors} <span className="text-gray-500">visitors (24h)</span></span>
                <span className="text-white">{recentStats.actions} <span className="text-gray-500">actions (24h)</span></span>
              </div>
            </div>
          )}

          {/* Platform Breakdown */}
          {platformBreakdown.length > 0 && (
            <div className="mb-8">
              <h2 className="text-lg font-semibold mb-3">Platform Breakdown</h2>
              <div className="rounded-xl border border-gray-800 bg-gray-900 p-4 space-y-3">
                {platformBreakdown.map(([platform, count]) => (
                  <div key={platform} className="flex items-center gap-3">
                    <span className="w-28 text-sm text-gray-300 capitalize">{platform}</span>
                    <div className="flex-1 h-6 bg-gray-800 rounded overflow-hidden">
                      <div
                        className={`h-full rounded ${platformColors[platform] || 'bg-blue-500'}`}
                        style={{ width: `${Math.max((count / maxPlatformCount) * 100, 4)}%` }}
                      />
                    </div>
                    <span className="w-12 text-sm text-gray-400 text-right">{count}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Actions Breakdown */}
          {actionsBreakdown.length > 0 && (
            <div className="mb-8">
              <h2 className="text-lg font-semibold mb-3">Actions Breakdown</h2>
              <div className="rounded-xl border border-gray-800 bg-gray-900 p-4 space-y-3">
                {actionsBreakdown.map(([name, count]) => (
                  <div key={name} className="flex items-center gap-3">
                    <span className="w-40 text-sm text-gray-300 truncate" title={name}>{name}</span>
                    <div className="flex-1 h-6 bg-gray-800 rounded overflow-hidden">
                      <div
                        className="h-full rounded bg-blue-500"
                        style={{ width: `${Math.max((count / maxActionCount) * 100, 4)}%` }}
                      />
                    </div>
                    <span className="w-12 text-sm text-gray-400 text-right">{count}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {actionsBreakdown.length === 0 && platformBreakdown.length === 0 && filteredSessions.length === 0 && (
            <div className="mb-8 rounded-xl border border-gray-800 bg-gray-900 p-8 text-center">
              <p className="text-gray-500">No analytics data for this scene in the selected time range.</p>
            </div>
          )}

          {/* Sessions Table */}
          <div className="mb-8">
            <h2 className="text-lg font-semibold mb-3">Sessions</h2>
            {sortedSessions.length === 0 ? (
              <div className="rounded-xl border border-gray-800 bg-gray-900 p-6 text-center">
                <p className="text-gray-500">No sessions in the selected time range.</p>
              </div>
            ) : (
              <div className="rounded-xl border border-gray-800 bg-gray-900 overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-800 text-gray-400">
                        <th className="text-left px-4 py-3 font-medium">User</th>
                        <th className="text-left px-4 py-3 font-medium">Platform</th>
                        <th
                          className="text-left px-4 py-3 font-medium cursor-pointer hover:text-white select-none"
                          onClick={() => setSortDesc(!sortDesc)}
                        >
                          Started {sortDesc ? '↓' : '↑'}
                        </th>
                        <th className="text-left px-4 py-3 font-medium">Duration</th>
                        <th className="text-right px-4 py-3 font-medium">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedSessions.map(session => (
                        <tr key={session.id} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                          <td className="px-4 py-3 text-gray-300">
                            {session.displayName || session.walletAddress?.slice(0, 10) || session.userId || 'Anonymous'}
                          </td>
                          <td className="px-4 py-3">
                            <span className={`inline-block rounded-full px-2 py-0.5 text-xs capitalize ${
                              session.platform
                                ? `${platformColors[session.platform] || 'bg-blue-500'} bg-opacity-20 text-white`
                                : 'bg-gray-700 text-gray-400'
                            }`}>
                              {session.platform || 'unknown'}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-gray-400">
                            {new Date(session.startedAt).toLocaleString()}
                          </td>
                          <td className="px-4 py-3 text-gray-400">
                            {sessionDuration(session)}
                          </td>
                          <td className="px-4 py-3 text-right text-gray-400">
                            {session.actions?.length || 0}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-4">
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className="text-2xl font-bold">{value}</p>
    </div>
  )
}
