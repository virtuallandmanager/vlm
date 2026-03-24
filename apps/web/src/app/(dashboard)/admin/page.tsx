'use client'

import { useAuth } from '@/lib/auth'
import { useApi } from '@/lib/api'
import { useState, useEffect, useCallback } from 'react'

type Tab = 'users' | 'orgs'

interface Stats {
  totalUsers: number
  totalOrgs: number
  totalScenes: number
  totalMedia: number
  totalStorageBytes: number
  activeSubscriptionsByTier: Record<string, number>
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`
}

export default function AdminPage() {
  const { user } = useAuth()
  const api = useApi()
  const [tab, setTab] = useState<Tab>('users')
  const [stats, setStats] = useState<Stats | null>(null)
  const [statsLoading, setStatsLoading] = useState(true)

  // Users state
  const [users, setUsers] = useState<any[]>([])
  const [usersTotal, setUsersTotal] = useState(0)
  const [usersOffset, setUsersOffset] = useState(0)
  const [usersSearch, setUsersSearch] = useState('')
  const [usersSearchInput, setUsersSearchInput] = useState('')
  const [usersLoading, setUsersLoading] = useState(false)
  const PAGE_SIZE = 25

  // Orgs state
  const [orgs, setOrgs] = useState<any[]>([])
  const [orgsTotal, setOrgsTotal] = useState(0)
  const [orgsOffset, setOrgsOffset] = useState(0)
  const [orgsLoading, setOrgsLoading] = useState(false)

  const loadStats = useCallback(async () => {
    try {
      setStatsLoading(true)
      const data = await api.getAdminStats()
      setStats(data)
    } catch (err) {
      console.error('Failed to load stats:', err)
    } finally {
      setStatsLoading(false)
    }
  }, [api])

  const loadUsers = useCallback(async () => {
    try {
      setUsersLoading(true)
      const data = await api.getAdminUsers({
        limit: PAGE_SIZE,
        offset: usersOffset,
        search: usersSearch || undefined,
      })
      setUsers(data.users)
      setUsersTotal(data.total)
    } catch (err) {
      console.error('Failed to load users:', err)
    } finally {
      setUsersLoading(false)
    }
  }, [api, usersOffset, usersSearch])

  const loadOrgs = useCallback(async () => {
    try {
      setOrgsLoading(true)
      const data = await api.getAdminOrgs({ limit: PAGE_SIZE, offset: orgsOffset })
      setOrgs(data.organizations)
      setOrgsTotal(data.total)
    } catch (err) {
      console.error('Failed to load orgs:', err)
    } finally {
      setOrgsLoading(false)
    }
  }, [api, orgsOffset])

  useEffect(() => {
    if (user?.role === 'admin') loadStats()
  }, [user?.role, loadStats])

  useEffect(() => {
    if (user?.role === 'admin' && tab === 'users') loadUsers()
  }, [user?.role, tab, loadUsers])

  useEffect(() => {
    if (user?.role === 'admin' && tab === 'orgs') loadOrgs()
  }, [user?.role, tab, loadOrgs])

  if (user?.role !== 'admin') {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-gray-400">Access denied. Admin role required.</p>
      </div>
    )
  }

  const handleRoleChange = async (userId: string, newRole: string) => {
    try {
      await api.updateUserRole(userId, newRole)
      setUsers((prev) =>
        prev.map((u) => (u.id === userId ? { ...u, role: newRole } : u)),
      )
    } catch (err) {
      alert(`Failed to update role: ${(err as Error).message}`)
    }
  }

  const handleDeleteUser = async (userId: string, displayName: string) => {
    if (!confirm(`Delete user "${displayName}"? This cannot be undone.`)) return
    try {
      await api.deleteUser(userId)
      setUsers((prev) => prev.filter((u) => u.id !== userId))
      setUsersTotal((prev) => prev - 1)
      loadStats()
    } catch (err) {
      alert(`Failed to delete user: ${(err as Error).message}`)
    }
  }

  const handleDeleteOrg = async (orgId: string, name: string) => {
    if (!confirm(`Delete organization "${name}"? This cannot be undone.`)) return
    try {
      await api.deleteOrg(orgId)
      setOrgs((prev) => prev.filter((o) => o.id !== orgId))
      setOrgsTotal((prev) => prev - 1)
      loadStats()
    } catch (err) {
      alert(`Failed to delete org: ${(err as Error).message}`)
    }
  }

  const handleUsersSearch = (e: React.FormEvent) => {
    e.preventDefault()
    setUsersOffset(0)
    setUsersSearch(usersSearchInput)
  }

  const totalUsersPages = Math.ceil(usersTotal / PAGE_SIZE)
  const currentUsersPage = Math.floor(usersOffset / PAGE_SIZE) + 1
  const totalOrgsPages = Math.ceil(orgsTotal / PAGE_SIZE)
  const currentOrgsPage = Math.floor(orgsOffset / PAGE_SIZE) + 1

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold">Admin Dashboard</h1>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {statsLoading ? (
          <div className="col-span-4 text-center text-gray-400 py-4">Loading stats...</div>
        ) : stats ? (
          <>
            <div className="bg-gray-800 rounded-lg p-4">
              <p className="text-sm text-gray-400">Total Users</p>
              <p className="text-2xl font-bold">{stats.totalUsers}</p>
            </div>
            <div className="bg-gray-800 rounded-lg p-4">
              <p className="text-sm text-gray-400">Total Organizations</p>
              <p className="text-2xl font-bold">{stats.totalOrgs}</p>
            </div>
            <div className="bg-gray-800 rounded-lg p-4">
              <p className="text-sm text-gray-400">Total Scenes</p>
              <p className="text-2xl font-bold">{stats.totalScenes}</p>
            </div>
            <div className="bg-gray-800 rounded-lg p-4">
              <p className="text-sm text-gray-400">Storage Used</p>
              <p className="text-2xl font-bold">{formatBytes(stats.totalStorageBytes)}</p>
            </div>
          </>
        ) : null}
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b border-gray-700 pb-0">
        <button
          onClick={() => setTab('users')}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
            tab === 'users'
              ? 'border-white text-white'
              : 'border-transparent text-gray-400 hover:text-white'
          }`}
        >
          Users
        </button>
        <button
          onClick={() => setTab('orgs')}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
            tab === 'orgs'
              ? 'border-white text-white'
              : 'border-transparent text-gray-400 hover:text-white'
          }`}
        >
          Organizations
        </button>
      </div>

      {/* Users Tab */}
      {tab === 'users' && (
        <div className="space-y-4">
          <form onSubmit={handleUsersSearch} className="flex gap-2">
            <input
              type="text"
              placeholder="Search by name or email..."
              value={usersSearchInput}
              onChange={(e) => setUsersSearchInput(e.target.value)}
              className="flex-1 rounded-lg bg-gray-800 border border-gray-700 px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-gray-500"
            />
            <button
              type="submit"
              className="rounded-lg bg-gray-700 px-4 py-2 text-sm text-white hover:bg-gray-600"
            >
              Search
            </button>
          </form>

          {usersLoading ? (
            <p className="text-gray-400 text-center py-8">Loading users...</p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead className="text-xs text-gray-400 uppercase border-b border-gray-700">
                    <tr>
                      <th className="px-3 py-2">Name</th>
                      <th className="px-3 py-2">Email</th>
                      <th className="px-3 py-2">Role</th>
                      <th className="px-3 py-2">Created</th>
                      <th className="px-3 py-2">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((u) => (
                      <tr key={u.id} className="border-b border-gray-800 hover:bg-gray-800/50">
                        <td className="px-3 py-2 text-white">{u.displayName}</td>
                        <td className="px-3 py-2 text-gray-300">{u.email || '-'}</td>
                        <td className="px-3 py-2">
                          <select
                            value={u.role}
                            onChange={(e) => handleRoleChange(u.id, e.target.value)}
                            className="bg-gray-700 border border-gray-600 text-white text-xs rounded px-2 py-1 focus:outline-none"
                          >
                            <option value="admin">admin</option>
                            <option value="creator">creator</option>
                            <option value="viewer">viewer</option>
                          </select>
                        </td>
                        <td className="px-3 py-2 text-gray-400">
                          {new Date(u.createdAt).toLocaleDateString()}
                        </td>
                        <td className="px-3 py-2">
                          <button
                            onClick={() => handleDeleteUser(u.id, u.displayName)}
                            className="text-red-400 hover:text-red-300 text-xs"
                            disabled={u.id === user?.id}
                            title={u.id === user?.id ? 'Cannot delete yourself' : 'Delete user'}
                          >
                            Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                    {users.length === 0 && (
                      <tr>
                        <td colSpan={5} className="px-3 py-8 text-center text-gray-500">
                          No users found.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              {usersTotal > PAGE_SIZE && (
                <div className="flex items-center justify-between text-sm text-gray-400">
                  <span>
                    Showing {usersOffset + 1}-{Math.min(usersOffset + PAGE_SIZE, usersTotal)} of{' '}
                    {usersTotal}
                  </span>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setUsersOffset((prev) => Math.max(0, prev - PAGE_SIZE))}
                      disabled={usersOffset === 0}
                      className="px-3 py-1 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Prev
                    </button>
                    <span className="px-2 py-1">
                      Page {currentUsersPage} of {totalUsersPages}
                    </span>
                    <button
                      onClick={() => setUsersOffset((prev) => prev + PAGE_SIZE)}
                      disabled={usersOffset + PAGE_SIZE >= usersTotal}
                      className="px-3 py-1 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Next
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Organizations Tab */}
      {tab === 'orgs' && (
        <div className="space-y-4">
          {orgsLoading ? (
            <p className="text-gray-400 text-center py-8">Loading organizations...</p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead className="text-xs text-gray-400 uppercase border-b border-gray-700">
                    <tr>
                      <th className="px-3 py-2">Name</th>
                      <th className="px-3 py-2">Slug</th>
                      <th className="px-3 py-2">Members</th>
                      <th className="px-3 py-2">Scenes</th>
                      <th className="px-3 py-2">Created</th>
                      <th className="px-3 py-2">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orgs.map((o) => (
                      <tr key={o.id} className="border-b border-gray-800 hover:bg-gray-800/50">
                        <td className="px-3 py-2 text-white">{o.name}</td>
                        <td className="px-3 py-2 text-gray-300">{o.slug}</td>
                        <td className="px-3 py-2 text-gray-300">{o.memberCount}</td>
                        <td className="px-3 py-2 text-gray-300">{o.sceneCount}</td>
                        <td className="px-3 py-2 text-gray-400">
                          {new Date(o.createdAt).toLocaleDateString()}
                        </td>
                        <td className="px-3 py-2">
                          <button
                            onClick={() => handleDeleteOrg(o.id, o.name)}
                            className="text-red-400 hover:text-red-300 text-xs"
                          >
                            Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                    {orgs.length === 0 && (
                      <tr>
                        <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                          No organizations found.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              {orgsTotal > PAGE_SIZE && (
                <div className="flex items-center justify-between text-sm text-gray-400">
                  <span>
                    Showing {orgsOffset + 1}-{Math.min(orgsOffset + PAGE_SIZE, orgsTotal)} of{' '}
                    {orgsTotal}
                  </span>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setOrgsOffset((prev) => Math.max(0, prev - PAGE_SIZE))}
                      disabled={orgsOffset === 0}
                      className="px-3 py-1 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Prev
                    </button>
                    <span className="px-2 py-1">
                      Page {currentOrgsPage} of {totalOrgsPages}
                    </span>
                    <button
                      onClick={() => setOrgsOffset((prev) => prev + PAGE_SIZE)}
                      disabled={orgsOffset + PAGE_SIZE >= orgsTotal}
                      className="px-3 py-1 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Next
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
