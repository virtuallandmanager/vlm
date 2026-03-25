'use client'
import { useApi } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useSearchParams, useRouter } from 'next/navigation'
import { useEffect, useState, Suspense } from 'react'

export default function DeployPage() {
  return (
    <Suspense fallback={<p className="text-gray-400">Loading...</p>}>
      <DeployContent />
    </Suspense>
  )
}

// -- Helpers ------------------------------------------------------------------

const statusColors: Record<string, string> = {
  pending: 'bg-blue-500',
  building: 'bg-yellow-500 animate-pulse',
  deploying: 'bg-yellow-500 animate-pulse',
  deployed: 'bg-green-500',
  failed: 'bg-red-500',
}

const statusLabels: Record<string, string> = {
  pending: 'Pending',
  building: 'Building',
  deploying: 'Deploying',
  deployed: 'Deployed',
  failed: 'Failed',
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium">
      <span className={`inline-block h-2 w-2 rounded-full ${statusColors[status] || 'bg-gray-500'}`} />
      {statusLabels[status] || status}
    </span>
  )
}

function PlatformBadge({ platform }: { platform: string }) {
  const colors: Record<string, string> = {
    decentraland: 'bg-purple-500/20 text-purple-400',
    hyperfy: 'bg-cyan-500/20 text-cyan-400',
  }
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${colors[platform] || 'bg-gray-500/20 text-gray-400'}`}>
      {platform === 'decentraland' ? 'Decentraland' : platform === 'hyperfy' ? 'Hyperfy' : platform}
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

// -- Main Content -------------------------------------------------------------

function DeployContent() {
  const { token } = useAuth()
  const api = useApi()
  const searchParams = useSearchParams()
  const router = useRouter()

  // Scene selector
  const [scenes, setScenes] = useState<any[]>([])
  const [selectedSceneId, setSelectedSceneId] = useState<string>(searchParams.get('scene') || '')
  const [loadingScenes, setLoadingScenes] = useState(true)

  // Deployments
  const [deployments, setDeployments] = useState<any[]>([])
  const [loadingDeployments, setLoadingDeployments] = useState(false)

  // New deployment form
  const [showNewDeploy, setShowNewDeploy] = useState(false)
  const [newPlatform, setNewPlatform] = useState<'decentraland' | 'hyperfy'>('decentraland')
  const [newDeployType, setNewDeployType] = useState<'parcel' | 'world' | 'instance'>('parcel')
  const [newParcels, setNewParcels] = useState('')
  const [newContentServer, setNewContentServer] = useState('')
  const [newHyperfyName, setNewHyperfyName] = useState('')
  const [newHyperfyRegion, setNewHyperfyRegion] = useState('')
  const [deploying, setDeploying] = useState(false)
  const [deployError, setDeployError] = useState('')

  // Wallets
  const [wallets, setWallets] = useState<any[]>([])
  const [loadingWallets, setLoadingWallets] = useState(true)
  const [showAddWallet, setShowAddWallet] = useState(false)
  const [walletAddress, setWalletAddress] = useState('')
  const [walletLabel, setWalletLabel] = useState('')
  const [addingWallet, setAddingWallet] = useState(false)
  const [walletError, setWalletError] = useState('')

  // Hyperfy instance details
  const [hyperfyLogs, setHyperfyLogs] = useState<Record<string, string>>({})
  const [hyperfyStatus, setHyperfyStatus] = useState<Record<string, any>>({})
  const [confirmDestroy, setConfirmDestroy] = useState<string | null>(null)
  const [destroying, setDestroying] = useState(false)

  // Action states
  const [actionLoading, setActionLoading] = useState<string | null>(null)

  // Load scenes
  useEffect(() => {
    if (!token) return
    api.getScenes().then((data) => {
      setScenes(data.scenes)
      setLoadingScenes(false)
      if (!selectedSceneId && data.scenes.length > 0) {
        const preselected = searchParams.get('scene')
        if (preselected && data.scenes.some((s: any) => s.id === preselected)) {
          setSelectedSceneId(preselected)
        }
      }
    }).catch(() => setLoadingScenes(false))

    api.getDeployWallets().then((data) => {
      setWallets(data.wallets)
      setLoadingWallets(false)
    }).catch(() => setLoadingWallets(false))
  }, [token])

  // Load deployments when scene changes
  useEffect(() => {
    if (!token || !selectedSceneId) {
      setDeployments([])
      return
    }
    setLoadingDeployments(true)
    api.getDeployments(selectedSceneId).then((data) => {
      setDeployments(data.deployments)
      setLoadingDeployments(false)
    }).catch(() => {
      setDeployments([])
      setLoadingDeployments(false)
    })
  }, [token, selectedSceneId])

  const handleSceneChange = (sceneId: string) => {
    setSelectedSceneId(sceneId)
    const url = sceneId ? `/deploy?scene=${sceneId}` : '/deploy'
    router.replace(url)
  }

  // -- Deploy Actions ---------------------------------------------------------

  const handleCreateDeployment = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!selectedSceneId) return
    setDeploying(true)
    setDeployError('')

    try {
      if (newPlatform === 'hyperfy') {
        const result = await api.provisionHyperfy({
          sceneId: selectedSceneId,
          name: newHyperfyName.trim() || scenes.find((s) => s.id === selectedSceneId)?.name || 'Hyperfy World',
          region: newHyperfyRegion.trim() || undefined,
        })
        // Refresh deployments
        const data = await api.getDeployments(selectedSceneId)
        setDeployments(data.deployments)
      } else {
        const target: Record<string, unknown> = {}
        if (newDeployType === 'parcel' || newDeployType === 'world') {
          if (newParcels.trim()) target.parcels = newParcels.trim()
          if (newContentServer.trim()) target.contentServer = newContentServer.trim()
        }

        const { deployment } = await api.createDeployment({
          sceneId: selectedSceneId,
          platform: newPlatform,
          deploymentType: newDeployType,
          target,
        })
        setDeployments((prev) => [deployment, ...prev])
      }
      setShowNewDeploy(false)
      resetNewDeployForm()
    } catch (err: any) {
      setDeployError(err.message || 'Deployment failed')
    }
    setDeploying(false)
  }

  const resetNewDeployForm = () => {
    setNewPlatform('decentraland')
    setNewDeployType('parcel')
    setNewParcels('')
    setNewContentServer('')
    setNewHyperfyName('')
    setNewHyperfyRegion('')
    setDeployError('')
  }

  const handleCancel = async (id: string) => {
    setActionLoading(id)
    try {
      const { deployment } = await api.cancelDeployment(id)
      setDeployments((prev) => prev.map((d) => (d.id === id ? deployment : d)))
    } catch { /* ignore */ }
    setActionLoading(null)
  }

  const handleRedeploy = async (id: string) => {
    setActionLoading(id)
    try {
      const { deployment } = await api.redeployDeployment(id)
      setDeployments((prev) => [deployment, ...prev])
    } catch { /* ignore */ }
    setActionLoading(null)
  }

  // -- Wallet Actions ---------------------------------------------------------

  const handleAddWallet = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!walletAddress.trim()) return
    setAddingWallet(true)
    setWalletError('')
    try {
      const { wallet } = await api.createDeployWallet({
        platform: 'decentraland',
        walletAddress: walletAddress.trim(),
        label: walletLabel.trim() || undefined,
      })
      setWallets((prev) => [...prev, wallet])
      setWalletAddress('')
      setWalletLabel('')
      setShowAddWallet(false)
    } catch (err: any) {
      setWalletError(err.message || 'Failed to add wallet')
    }
    setAddingWallet(false)
  }

  const handleDeleteWallet = async (id: string) => {
    try {
      await api.deleteDeployWallet(id)
      setWallets((prev) => prev.filter((w) => w.id !== id))
    } catch { /* ignore */ }
  }

  // -- Hyperfy Actions --------------------------------------------------------

  const handleViewLogs = async (deploymentId: string, infraId: string) => {
    try {
      const { logs } = await api.getHyperfyLogs(infraId)
      setHyperfyLogs((prev) => ({ ...prev, [deploymentId]: logs }))
    } catch {
      setHyperfyLogs((prev) => ({ ...prev, [deploymentId]: 'Failed to fetch logs.' }))
    }
  }

  const handleViewStatus = async (deploymentId: string, infraId: string) => {
    try {
      const { instance } = await api.getHyperfyStatus(infraId)
      setHyperfyStatus((prev) => ({ ...prev, [deploymentId]: instance }))
    } catch {
      setHyperfyStatus((prev) => ({ ...prev, [deploymentId]: { error: 'Failed to fetch status' } }))
    }
  }

  const handleDestroy = async (infraId: string, deploymentId: string) => {
    setDestroying(true)
    try {
      await api.destroyHyperfy(infraId)
      // Refresh deployments
      if (selectedSceneId) {
        const data = await api.getDeployments(selectedSceneId)
        setDeployments(data.deployments)
      }
      setConfirmDestroy(null)
    } catch { /* ignore */ }
    setDestroying(false)
  }

  // -- Render -----------------------------------------------------------------

  if (loadingScenes) return <p className="text-gray-400">Loading...</p>

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Deploy</h1>
        {selectedSceneId && (
          <button
            onClick={() => { setShowNewDeploy(!showNewDeploy); resetNewDeployForm() }}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-700"
          >
            + New Deployment
          </button>
        )}
      </div>

      {/* Scene Selector */}
      <div>
        <label className="block text-xs text-gray-400 mb-1">Select Scene</label>
        <select
          value={selectedSceneId}
          onChange={(e) => handleSceneChange(e.target.value)}
          className="w-full max-w-md rounded-lg bg-gray-800 px-4 py-2 text-white outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">-- Choose a scene --</option>
          {scenes.map((scene) => (
            <option key={scene.id} value={scene.id}>{scene.name}</option>
          ))}
        </select>
      </div>

      {!selectedSceneId && (
        <div className="text-center py-12">
          <p className="text-gray-500 mb-2">Select a scene to view and manage deployments.</p>
          <p className="text-sm text-gray-600">You can deploy scenes to Decentraland or Hyperfy.</p>
        </div>
      )}

      {/* New Deployment Form */}
      {showNewDeploy && selectedSceneId && (
        <form onSubmit={handleCreateDeployment} className="space-y-4 rounded-xl border border-gray-800 bg-gray-900 p-5">
          <h2 className="text-lg font-semibold">New Deployment</h2>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Platform</label>
              <select
                value={newPlatform}
                onChange={(e) => {
                  setNewPlatform(e.target.value as 'decentraland' | 'hyperfy')
                  if (e.target.value === 'hyperfy') setNewDeployType('instance')
                  else setNewDeployType('parcel')
                }}
                className="w-full rounded-lg bg-gray-800 px-4 py-2 text-white outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="decentraland">Decentraland</option>
                <option value="hyperfy">Hyperfy</option>
              </select>
            </div>

            {newPlatform === 'decentraland' && (
              <div>
                <label className="block text-xs text-gray-400 mb-1">Deployment Type</label>
                <select
                  value={newDeployType}
                  onChange={(e) => setNewDeployType(e.target.value as 'parcel' | 'world' | 'instance')}
                  className="w-full rounded-lg bg-gray-800 px-4 py-2 text-white outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="parcel">Parcel</option>
                  <option value="world">World</option>
                </select>
              </div>
            )}
          </div>

          {newPlatform === 'decentraland' && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Parcels</label>
                <input
                  type="text"
                  value={newParcels}
                  onChange={(e) => setNewParcels(e.target.value)}
                  placeholder="e.g. 0,0 0,1 1,0 1,1"
                  className="w-full rounded-lg bg-gray-800 px-4 py-2 text-white outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Content Server URL</label>
                <input
                  type="text"
                  value={newContentServer}
                  onChange={(e) => setNewContentServer(e.target.value)}
                  placeholder="https://peer.decentraland.org/content"
                  className="w-full rounded-lg bg-gray-800 px-4 py-2 text-white outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
          )}

          {newPlatform === 'hyperfy' && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-xs text-gray-400 mb-1">World Name</label>
                <input
                  type="text"
                  value={newHyperfyName}
                  onChange={(e) => setNewHyperfyName(e.target.value)}
                  placeholder="My Hyperfy World"
                  className="w-full rounded-lg bg-gray-800 px-4 py-2 text-white outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Region (optional)</label>
                <input
                  type="text"
                  value={newHyperfyRegion}
                  onChange={(e) => setNewHyperfyRegion(e.target.value)}
                  placeholder="us-east-1"
                  className="w-full rounded-lg bg-gray-800 px-4 py-2 text-white outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
          )}

          {deployError && <p className="text-sm text-red-400">{deployError}</p>}

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={deploying}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm hover:bg-blue-700 disabled:opacity-50"
            >
              {deploying
                ? 'Deploying...'
                : newPlatform === 'hyperfy'
                  ? 'Provision World'
                  : 'Start Deployment'}
            </button>
            <button
              type="button"
              onClick={() => { setShowNewDeploy(false); resetNewDeployForm() }}
              className="rounded-lg bg-gray-800 px-4 py-2 text-sm hover:bg-gray-700"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Deployments List */}
      {selectedSceneId && (
        <div>
          <h2 className="text-lg font-semibold mb-3">Deployments</h2>
          {loadingDeployments ? (
            <p className="text-gray-400">Loading deployments...</p>
          ) : deployments.length === 0 ? (
            <div className="text-center py-8 rounded-xl border border-gray-800 bg-gray-900">
              <p className="text-gray-500 mb-2">No deployments for this scene yet.</p>
              <p className="text-sm text-gray-600">Click &quot;+ New Deployment&quot; to get started.</p>
            </div>
          ) : (
            <div className="space-y-4">
              {deployments.map((dep) => (
                <DeploymentCard
                  key={dep.id}
                  deployment={dep}
                  actionLoading={actionLoading === dep.id}
                  onCancel={() => handleCancel(dep.id)}
                  onRedeploy={() => handleRedeploy(dep.id)}
                  hyperfyLogs={hyperfyLogs[dep.id]}
                  hyperfyStatusData={hyperfyStatus[dep.id]}
                  onViewLogs={() => dep.infrastructureId && handleViewLogs(dep.id, dep.infrastructureId)}
                  onViewStatus={() => dep.infrastructureId && handleViewStatus(dep.id, dep.infrastructureId)}
                  confirmDestroy={confirmDestroy === dep.id}
                  onConfirmDestroy={() => setConfirmDestroy(dep.id)}
                  onCancelDestroy={() => setConfirmDestroy(null)}
                  onDestroy={() => dep.infrastructureId && handleDestroy(dep.infrastructureId, dep.id)}
                  destroying={destroying && confirmDestroy === dep.id}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Deploy Wallets */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">Deploy Wallets</h2>
          <button
            onClick={() => setShowAddWallet(!showAddWallet)}
            className="rounded-lg bg-gray-800 px-3 py-1.5 text-xs font-medium hover:bg-gray-700"
          >
            + Add Wallet
          </button>
        </div>

        {showAddWallet && (
          <form onSubmit={handleAddWallet} className="mb-4 space-y-3 rounded-xl border border-gray-800 bg-gray-900 p-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Wallet Address</label>
                <input
                  type="text"
                  value={walletAddress}
                  onChange={(e) => setWalletAddress(e.target.value)}
                  placeholder="0x..."
                  autoFocus
                  className="w-full rounded-lg bg-gray-800 px-4 py-2 text-white outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Label (optional)</label>
                <input
                  type="text"
                  value={walletLabel}
                  onChange={(e) => setWalletLabel(e.target.value)}
                  placeholder="My deploy wallet"
                  className="w-full rounded-lg bg-gray-800 px-4 py-2 text-white outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
            {walletError && <p className="text-sm text-red-400">{walletError}</p>}
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={addingWallet}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm hover:bg-blue-700 disabled:opacity-50"
              >
                {addingWallet ? 'Adding...' : 'Add Wallet'}
              </button>
              <button
                type="button"
                onClick={() => { setShowAddWallet(false); setWalletError('') }}
                className="rounded-lg bg-gray-800 px-4 py-2 text-sm hover:bg-gray-700"
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {loadingWallets ? (
          <p className="text-gray-400 text-sm">Loading wallets...</p>
        ) : wallets.length === 0 ? (
          <div className="text-center py-6 rounded-xl border border-gray-800 bg-gray-900">
            <p className="text-gray-500 text-sm">No deploy wallets configured.</p>
            <p className="text-xs text-gray-600 mt-1">Add a wallet to deploy to Decentraland.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {wallets.map((wallet) => (
              <div key={wallet.id} className="flex items-center justify-between rounded-xl border border-gray-800 bg-gray-900 px-4 py-3">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-xs font-medium text-gray-400 capitalize">{wallet.platform}</span>
                  <code className="text-sm text-gray-300 font-mono truncate">{wallet.walletAddress}</code>
                  {wallet.label && <span className="text-xs text-gray-500">({wallet.label})</span>}
                  {wallet.hasPrivateKey && (
                    <span className="inline-flex items-center rounded-full bg-green-500/20 px-2 py-0.5 text-xs text-green-400">
                      Key stored
                    </span>
                  )}
                </div>
                <button
                  onClick={() => handleDeleteWallet(wallet.id)}
                  className="rounded bg-red-600/20 px-2 py-1 text-xs text-red-400 hover:bg-red-600/30 shrink-0 ml-2"
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// -- Deployment Card ----------------------------------------------------------

function DeploymentCard({
  deployment,
  actionLoading,
  onCancel,
  onRedeploy,
  hyperfyLogs,
  hyperfyStatusData,
  onViewLogs,
  onViewStatus,
  confirmDestroy,
  onConfirmDestroy,
  onCancelDestroy,
  onDestroy,
  destroying,
}: {
  deployment: any
  actionLoading: boolean
  onCancel: () => void
  onRedeploy: () => void
  hyperfyLogs?: string
  hyperfyStatusData?: any
  onViewLogs: () => void
  onViewStatus: () => void
  confirmDestroy: boolean
  onConfirmDestroy: () => void
  onCancelDestroy: () => void
  onDestroy: () => void
  destroying: boolean
}) {
  const target = (deployment.target || {}) as Record<string, any>
  const isHyperfy = deployment.platform === 'hyperfy'
  const canCancel = deployment.status === 'pending' || deployment.status === 'building'

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-5 space-y-3">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <PlatformBadge platform={deployment.platform} />
          <span className="text-sm text-gray-400 capitalize">{deployment.deploymentType}</span>
        </div>
        <StatusBadge status={deployment.status} />
      </div>

      {/* Info Grid */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 text-sm">
        {target.parcels && (
          <div>
            <span className="text-xs text-gray-500">Parcels</span>
            <p className="text-gray-300 font-mono text-xs">{typeof target.parcels === 'string' ? target.parcels : JSON.stringify(target.parcels)}</p>
          </div>
        )}
        {target.contentServer && (
          <div>
            <span className="text-xs text-gray-500">Content Server</span>
            <p className="text-gray-300 font-mono text-xs truncate">{target.contentServer}</p>
          </div>
        )}
        {target.instanceUrl && (
          <div>
            <span className="text-xs text-gray-500">Instance URL</span>
            <a href={target.instanceUrl} target="_blank" rel="noreferrer" className="text-blue-400 font-mono text-xs truncate block hover:underline">
              {target.instanceUrl}
            </a>
          </div>
        )}
        {target.region && (
          <div>
            <span className="text-xs text-gray-500">Region</span>
            <p className="text-gray-300 text-xs">{target.region}</p>
          </div>
        )}
        {deployment.catalystEntityId && (
          <div>
            <span className="text-xs text-gray-500">Catalyst Entity</span>
            <p className="text-gray-300 font-mono text-xs truncate">{deployment.catalystEntityId}</p>
          </div>
        )}
        <div>
          <span className="text-xs text-gray-500">Created</span>
          <p className="text-gray-300 text-xs">{formatDateTime(deployment.createdAt)}</p>
        </div>
        {deployment.deployedAt && (
          <div>
            <span className="text-xs text-gray-500">Deployed</span>
            <p className="text-gray-300 text-xs">{formatDateTime(deployment.deployedAt)}</p>
          </div>
        )}
      </div>

      {/* Error */}
      {deployment.errorMessage && (
        <div className="rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2">
          <p className="text-sm text-red-400">{deployment.errorMessage}</p>
        </div>
      )}

      {/* Hyperfy Status */}
      {isHyperfy && hyperfyStatusData && (
        <div className="rounded-lg bg-gray-800 px-3 py-2">
          <p className="text-xs text-gray-400 mb-1">Instance Status</p>
          <pre className="text-xs text-gray-300 font-mono whitespace-pre-wrap overflow-x-auto">
            {hyperfyStatusData.error
              ? hyperfyStatusData.error
              : JSON.stringify(hyperfyStatusData, null, 2)}
          </pre>
        </div>
      )}

      {/* Hyperfy Logs */}
      {isHyperfy && hyperfyLogs !== undefined && (
        <div className="rounded-lg bg-gray-800 px-3 py-2">
          <p className="text-xs text-gray-400 mb-1">Logs</p>
          <pre className="text-xs text-gray-300 font-mono whitespace-pre-wrap overflow-x-auto max-h-48 overflow-y-auto">
            {hyperfyLogs || 'No logs available.'}
          </pre>
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-wrap gap-2 pt-1">
        {canCancel && (
          <button
            onClick={onCancel}
            disabled={actionLoading}
            className="rounded-lg bg-yellow-600/20 px-3 py-1.5 text-xs text-yellow-400 hover:bg-yellow-600/30 disabled:opacity-50"
          >
            {actionLoading ? 'Cancelling...' : 'Cancel'}
          </button>
        )}
        <button
          onClick={onRedeploy}
          disabled={actionLoading}
          className="rounded-lg bg-blue-600/20 px-3 py-1.5 text-xs text-blue-400 hover:bg-blue-600/30 disabled:opacity-50"
        >
          {actionLoading ? 'Redeploying...' : 'Redeploy'}
        </button>

        {isHyperfy && deployment.infrastructureId && (
          <>
            <button
              onClick={onViewStatus}
              className="rounded-lg bg-gray-700 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-600"
            >
              Status
            </button>
            <button
              onClick={onViewLogs}
              className="rounded-lg bg-gray-700 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-600"
            >
              View Logs
            </button>
            {!confirmDestroy ? (
              <button
                onClick={onConfirmDestroy}
                className="rounded-lg bg-red-600/20 px-3 py-1.5 text-xs text-red-400 hover:bg-red-600/30"
              >
                Destroy
              </button>
            ) : (
              <>
                <button
                  onClick={onDestroy}
                  disabled={destroying}
                  className="rounded-lg bg-red-600 px-3 py-1.5 text-xs text-white hover:bg-red-700 disabled:opacity-50"
                >
                  {destroying ? 'Destroying...' : 'Confirm Destroy'}
                </button>
                <button
                  onClick={onCancelDestroy}
                  className="rounded-lg bg-gray-700 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-600"
                >
                  Cancel
                </button>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
