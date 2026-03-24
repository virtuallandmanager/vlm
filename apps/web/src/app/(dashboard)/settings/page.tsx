'use client'
import { useApi } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useEffect, useState } from 'react'

export default function SettingsPage() {
  const { user, token } = useAuth()
  const api = useApi()
  const [orgs, setOrgs] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [newOrgName, setNewOrgName] = useState('')
  const [expandedOrgId, setExpandedOrgId] = useState<string | null>(null)
  const [members, setMembers] = useState<Record<string, any[]>>({})
  const [membersLoading, setMembersLoading] = useState<string | null>(null)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState('member')
  const [error, setError] = useState<string | null>(null)
  const [activeOrgId, setActiveOrgId] = useState<string | null>(null)

  // API Keys state
  const [apiKeys, setApiKeys] = useState<any[]>([])
  const [apiKeysLoading, setApiKeysLoading] = useState(true)
  const [newKeyName, setNewKeyName] = useState('')
  const [createdKey, setCreatedKey] = useState<string | null>(null)
  const [keyCopied, setKeyCopied] = useState(false)
  const [showCreateKey, setShowCreateKey] = useState(false)
  const [deletingKeyId, setDeletingKeyId] = useState<string | null>(null)

  useEffect(() => {
    if (!token) return
    api.getOrgs()
      .then(data => {
        setOrgs(data.organizations)
        // Detect active org — look for one flagged active, or fall back to first
        const active = data.organizations.find((o: any) => o.isActive) || data.organizations[0]
        if (active) setActiveOrgId(active.id)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [token])

  // Fetch API keys
  useEffect(() => {
    if (!token) return
    api.getApiKeys()
      .then(data => {
        setApiKeys(data.keys)
        setApiKeysLoading(false)
      })
      .catch(() => setApiKeysLoading(false))
  }, [token])

  const handleCreateApiKey = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newKeyName.trim()) return
    setError(null)
    try {
      const { key, apiKey } = await api.createApiKey(newKeyName.trim())
      setApiKeys(prev => [apiKey, ...prev])
      setCreatedKey(key)
      setKeyCopied(false)
      setNewKeyName('')
      setShowCreateKey(false)
    } catch (err: any) {
      setError(err.message)
    }
  }

  const handleCopyKey = async () => {
    if (!createdKey) return
    await navigator.clipboard.writeText(createdKey)
    setKeyCopied(true)
  }

  const handleDeleteApiKey = async (keyId: string) => {
    setError(null)
    try {
      await api.deleteApiKey(keyId)
      setApiKeys(prev => prev.filter(k => k.id !== keyId))
      setDeletingKeyId(null)
    } catch (err: any) {
      setError(err.message)
    }
  }

  const handleCreateOrg = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newOrgName.trim()) return
    setError(null)
    try {
      const { organization } = await api.createOrg(newOrgName.trim())
      setOrgs(prev => [organization, ...prev])
      setNewOrgName('')
      setShowCreate(false)
    } catch (err: any) {
      setError(err.message)
    }
  }

  const handleToggleExpand = async (orgId: string) => {
    if (expandedOrgId === orgId) {
      setExpandedOrgId(null)
      return
    }
    setExpandedOrgId(orgId)
    if (!members[orgId]) {
      setMembersLoading(orgId)
      try {
        const data = await api.getOrgMembers(orgId)
        setMembers(prev => ({ ...prev, [orgId]: data.members }))
      } catch {
        setMembers(prev => ({ ...prev, [orgId]: [] }))
      }
      setMembersLoading(null)
    }
  }

  const handleSwitchOrg = async (orgId: string) => {
    setError(null)
    try {
      await api.setActiveOrg(orgId)
      setActiveOrgId(orgId)
    } catch (err: any) {
      setError(err.message)
    }
  }

  const handleInvite = async (orgId: string) => {
    if (!inviteEmail.trim()) return
    setError(null)
    try {
      await api.inviteToOrg(orgId, inviteEmail.trim(), inviteRole)
      setInviteEmail('')
      setInviteRole('member')
    } catch (err: any) {
      setError(err.message)
    }
  }

  const handleRemoveMember = async (orgId: string, userId: string) => {
    setError(null)
    try {
      await api.removeOrgMember(orgId, userId)
      setMembers(prev => ({
        ...prev,
        [orgId]: (prev[orgId] || []).filter((m: any) => m.userId !== userId),
      }))
    } catch (err: any) {
      setError(err.message)
    }
  }

  const isAdminOrOwner = (org: any) => {
    return org.role === 'owner' || org.role === 'admin'
  }

  if (loading) return <p className="text-gray-400">Loading organizations...</p>

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Settings</h1>
      </div>

      {error && (
        <div className="mb-4 rounded-lg bg-red-900/50 border border-red-700 px-4 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      {/* Your Organizations */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Your Organizations</h2>
          <button onClick={() => setShowCreate(!showCreate)}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-700">
            + Create Organization
          </button>
        </div>

        {showCreate && (
          <form onSubmit={handleCreateOrg} className="mb-6 flex gap-2">
            <input type="text" value={newOrgName} onChange={e => setNewOrgName(e.target.value)}
              placeholder="Organization name" autoFocus
              className="flex-1 rounded-lg bg-gray-800 px-4 py-2 text-white outline-none focus:ring-2 focus:ring-blue-500" />
            <button type="submit" className="rounded-lg bg-blue-600 px-4 py-2 text-sm hover:bg-blue-700">Create</button>
            <button type="button" onClick={() => setShowCreate(false)} className="rounded-lg bg-gray-800 px-4 py-2 text-sm hover:bg-gray-700">Cancel</button>
          </form>
        )}

        {orgs.length === 0 ? (
          <p className="text-gray-500">No organizations yet. Create one to get started.</p>
        ) : (
          <div className="space-y-3">
            {orgs.map(org => (
              <div key={org.id} className="rounded-xl border border-gray-800 bg-gray-900 overflow-hidden">
                {/* Org header */}
                <div className="flex items-center justify-between p-4 cursor-pointer hover:bg-gray-800/50 transition-colors"
                  onClick={() => handleToggleExpand(org.id)}>
                  <div className="flex items-center gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="font-semibold">{org.name}</h3>
                        {activeOrgId === org.id && (
                          <span className="rounded-full bg-green-900/50 border border-green-700 px-2 py-0.5 text-xs text-green-400">Active</span>
                        )}
                      </div>
                      <p className="mt-0.5 text-sm text-gray-400">
                        Role: <span className="capitalize">{org.role}</span>
                        {org.memberCount != null && <> &middot; {org.memberCount} member{org.memberCount !== 1 ? 's' : ''}</>}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {activeOrgId !== org.id && (
                      <button onClick={(e) => { e.stopPropagation(); handleSwitchOrg(org.id) }}
                        className="rounded-lg bg-gray-700 px-3 py-1.5 text-xs font-medium hover:bg-gray-600 transition-colors">
                        Switch
                      </button>
                    )}
                    <span className="text-gray-500 text-sm">{expandedOrgId === org.id ? '▲' : '▼'}</span>
                  </div>
                </div>

                {/* Expanded members section */}
                {expandedOrgId === org.id && (
                  <div className="border-t border-gray-800 p-4">
                    <h4 className="text-sm font-medium text-gray-300 mb-3">Members</h4>

                    {membersLoading === org.id ? (
                      <p className="text-sm text-gray-500">Loading members...</p>
                    ) : (members[org.id] || []).length === 0 ? (
                      <p className="text-sm text-gray-500">No members found.</p>
                    ) : (
                      <div className="space-y-2 mb-4">
                        {(members[org.id] || []).map((member: any) => (
                          <div key={member.userId} className="flex items-center justify-between rounded-lg bg-gray-800 px-3 py-2">
                            <div>
                              <p className="text-sm text-white">{member.displayName || member.email || member.userId}</p>
                              <p className="text-xs text-gray-400 capitalize">{member.role}</p>
                            </div>
                            {isAdminOrOwner(org) && member.userId !== user?.id && (
                              <button onClick={() => handleRemoveMember(org.id, member.userId)}
                                className="rounded-lg bg-red-900/50 border border-red-800 px-2 py-1 text-xs text-red-400 hover:bg-red-900 transition-colors">
                                Remove
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Invite form for admins/owners */}
                    {isAdminOrOwner(org) && (
                      <div className="mt-4 border-t border-gray-800 pt-4">
                        <h4 className="text-sm font-medium text-gray-300 mb-2">Invite Member</h4>
                        <div className="flex gap-2">
                          <input type="email" value={inviteEmail} onChange={e => setInviteEmail(e.target.value)}
                            placeholder="Email address"
                            className="flex-1 rounded-lg bg-gray-800 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-blue-500" />
                          <select value={inviteRole} onChange={e => setInviteRole(e.target.value)}
                            className="rounded-lg bg-gray-800 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-blue-500">
                            <option value="member">Member</option>
                            <option value="admin">Admin</option>
                          </select>
                          <button onClick={() => handleInvite(org.id)}
                            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-700">
                            Invite
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* API Keys */}
      <section className="mt-10">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">API Keys</h2>
          <button onClick={() => { setShowCreateKey(!showCreateKey); setCreatedKey(null) }}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-700">
            + Create API Key
          </button>
        </div>

        {/* Newly created key banner */}
        {createdKey && (
          <div className="mb-6 rounded-xl border border-yellow-700 bg-yellow-900/30 p-4">
            <p className="text-sm font-medium text-yellow-300 mb-2">
              This key will only be shown once. Copy it now.
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded-lg bg-gray-900 px-4 py-2 text-sm text-white font-mono select-all break-all">
                {createdKey}
              </code>
              <button onClick={handleCopyKey}
                className="shrink-0 rounded-lg bg-gray-700 px-4 py-2 text-sm font-medium hover:bg-gray-600 transition-colors">
                {keyCopied ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <button onClick={() => setCreatedKey(null)}
              className="mt-3 text-xs text-gray-400 hover:text-gray-300 transition-colors">
              Dismiss
            </button>
          </div>
        )}

        {/* Create key form */}
        {showCreateKey && (
          <form onSubmit={handleCreateApiKey} className="mb-6 flex gap-2">
            <input type="text" value={newKeyName} onChange={e => setNewKeyName(e.target.value)}
              placeholder="Key name (e.g. production, ci/cd)" autoFocus
              className="flex-1 rounded-lg bg-gray-800 px-4 py-2 text-white outline-none focus:ring-2 focus:ring-blue-500" />
            <button type="submit" className="rounded-lg bg-blue-600 px-4 py-2 text-sm hover:bg-blue-700">Create</button>
            <button type="button" onClick={() => setShowCreateKey(false)} className="rounded-lg bg-gray-800 px-4 py-2 text-sm hover:bg-gray-700">Cancel</button>
          </form>
        )}

        {apiKeysLoading ? (
          <p className="text-gray-400">Loading API keys...</p>
        ) : apiKeys.length === 0 ? (
          <p className="text-gray-500">No API keys yet. Create one to get started.</p>
        ) : (
          <div className="space-y-3">
            {apiKeys.map(key => (
              <div key={key.id} className="flex items-center justify-between rounded-xl border border-gray-800 bg-gray-900 p-4">
                <div className="min-w-0">
                  <p className="font-medium text-white">{key.name}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-gray-400">
                    <span className="font-mono">{key.prefix ? `${key.prefix}...` : '---'}</span>
                    <span>Created {key.createdAt ? new Date(key.createdAt).toLocaleDateString() : '---'}</span>
                    <span>Last used {key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleDateString() : 'Never'}</span>
                  </div>
                </div>
                <div className="shrink-0 ml-4">
                  {deletingKeyId === key.id ? (
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-red-400">Delete?</span>
                      <button onClick={() => handleDeleteApiKey(key.id)}
                        className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 transition-colors">
                        Confirm
                      </button>
                      <button onClick={() => setDeletingKeyId(null)}
                        className="rounded-lg bg-gray-800 px-3 py-1.5 text-xs font-medium hover:bg-gray-700 transition-colors">
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button onClick={() => setDeletingKeyId(key.id)}
                      className="rounded-lg bg-red-900/50 border border-red-800 px-3 py-1.5 text-xs text-red-400 hover:bg-red-900 transition-colors">
                      Delete
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
