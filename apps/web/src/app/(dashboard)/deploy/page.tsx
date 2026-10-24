'use client'
import { deployErrorMessage, listedDeployments } from '@/lib/deploy'
import { useApi } from '@/lib/api'
import { API_URL } from '@/lib/config'
import { destroyWorldPrompt, hyperfyErrorMessage, lastSeenLabel, noSlotsLine, removeWorldPrompt, setupSteps, shortDate, slotLine, worldStatusLabel } from '@/lib/hyperfy'
import type { HyperfyWorldSummary } from 'vlm-shared'
import { useAuth } from '@/lib/auth'
import Link from 'next/link'
import { useSearchParams, useRouter } from 'next/navigation'
import { useEffect, useState, Suspense } from 'react'
import { Badge, ConfirmAction, PageHeader, PlatformBadge, PrimaryButton, Skeleton, StatusDot } from '@/components/ui'
import { PlusIcon } from '@/components/icons'

export default function DeployPage() {
  return (
    <Suspense fallback={<Skeleton />}>
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
  return <StatusDot dot={statusColors[status] || 'bg-gray-500'} label={statusLabels[status] || status} />
}

function formatDateTime(iso: string | null) {
  if (!iso) return '--'
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

// -- Your Hyperfy worlds (self-run and VLM-hosted) -----------------------------

const POLL_MS = 5000

/** An end date picked in the form is the end of that day, UTC. */
const endOfDayUtc = (day: string) => new Date(`${day}T23:59:59Z`).toISOString()

type Shown =
  | { kind: 'key'; worldName: string; key: string }
  | { kind: 'created'; worldName: string; address: string | null; adminCode: string }

function HyperfyWorlds({ sceneId }: { sceneId: string }) {
  const { token } = useAuth()
  const api = useApi()
  const [worlds, setWorlds] = useState<HyperfyWorldSummary[]>([])
  const [slots, setSlots] = useState<{ used: number; limit: number; hostingAvailable: boolean } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [name, setName] = useState('')
  const [hostedName, setHostedName] = useState('')
  const [hostedEnd, setHostedEnd] = useState('')
  const [busy, setBusy] = useState(false)
  // Keys and admin codes live only in this component's state: shown once, dropped when the scene changes.
  const [shown, setShown] = useState<Shown | null>(null)
  const [revealed, setRevealed] = useState<{ id: string; code: string } | null>(null)
  const [editing, setEditing] = useState<{ id: string; day: string } | null>(null)
  const [copied, setCopied] = useState(false)

  const refreshSlots = () =>
    api.getHyperfySlots()
      .then((s) => setSlots({ used: s.used, limit: s.limit ?? Infinity, hostingAvailable: s.hostingAvailable }))
      .catch(() => setSlots(null))

  useEffect(() => {
    if (!token) return
    let stale = false
    setLoading(true)
    setError('')
    setNotice('')
    setShown(null)
    setRevealed(null)
    setEditing(null)
    api.getHyperfyWorlds(sceneId)
      .then((d) => { if (!stale) setWorlds(d.worlds) })
      .catch((err) => { if (!stale) { setWorlds([]); setError(hyperfyErrorMessage(err)) } })
      .finally(() => { if (!stale) setLoading(false) })
    api.getHyperfySlots()
      .then((s) => { if (!stale) setSlots({ used: s.used, limit: s.limit ?? Infinity, hostingAvailable: s.hostingAvailable }) })
      .catch(() => { if (!stale) setSlots(null) })
    return () => { stale = true }
  }, [token, sceneId])

  // Worlds still setting up refresh every few seconds until they settle.
  const settling = worlds.some((w) => w.status === 'provisioning')
  useEffect(() => {
    if (!token || !settling) return
    let stale = false
    const timer = setInterval(() => {
      api.getHyperfyWorlds(sceneId)
        .then((d) => { if (!stale) { setWorlds(d.worlds); refreshSlots() } })
        .catch(() => { /* keep the last list; the next tick retries */ })
    }, POLL_MS)
    return () => { stale = true; clearInterval(timer) }
  }, [token, sceneId, settling])

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await action()
    } catch (err) {
      setError(hyperfyErrorMessage(err))
    }
    setBusy(false)
  }

  const replaceWorld = (world: HyperfyWorldSummary) => setWorlds((prev) => prev.map((x) => (x.id === world.id ? world : x)))

  const connect = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    return run(async () => {
      const { world, key } = await api.createHyperfyWorld({ sceneId, name: name.trim() })
      setWorlds((prev) => [...prev, world])
      setShown({ kind: 'key', worldName: world.name, key })
      setCopied(false)
      setName('')
    })
  }

  const createHosted = (e: React.FormEvent) => {
    e.preventDefault()
    if (!hostedName.trim()) return
    if (hostedEnd && new Date(endOfDayUtc(hostedEnd)).getTime() <= Date.now()) {
      setError('Pick an end date in the future.')
      return
    }
    return run(async () => {
      try {
        const { world, adminCode } = await api.createHostedHyperfyWorld({
          sceneId,
          name: hostedName.trim(),
          endsAt: hostedEnd ? endOfDayUtc(hostedEnd) : null,
        })
        setWorlds((prev) => [...prev, world])
        setShown({ kind: 'created', worldName: world.name, address: world.address, adminCode })
        setCopied(false)
        setHostedName('')
        setHostedEnd('')
      } finally {
        refreshSlots()
      }
    })
  }

  const rotate = (w: HyperfyWorldSummary) => {
    const hosted = w.kind === 'hosted'
    return run(async () => {
      const { world, key } = await api.rotateHyperfyWorldKey(w.id)
      replaceWorld(world)
      if (hosted) {
        setNotice(`"${world.name}" restarted with a new key.`)
      } else {
        setShown({ kind: 'key', worldName: world.name, key })
        setCopied(false)
      }
    })
  }

  const remove = (w: HyperfyWorldSummary) => {
    const hosted = w.kind === 'hosted'
    return run(async () => {
      try {
        await api.deleteHyperfyWorld(w.id)
        setWorlds((prev) => prev.filter((x) => x.id !== w.id))
        setShown(null)
        setRevealed((r) => (r?.id === w.id ? null : r))
      } finally {
        if (hosted) refreshSlots()
      }
    })
  }

  const saveEndDate = (w: HyperfyWorldSummary, day: string | null) => {
    if (day && new Date(endOfDayUtc(day)).getTime() <= Date.now()) {
      setError('Pick an end date in the future.')
      return
    }
    return run(async () => {
      const { world } = await api.setHyperfyWorldEndDate(w.id, day ? endOfDayUtc(day) : null)
      replaceWorld(world)
      setEditing(null)
    })
  }

  const restore = (w: HyperfyWorldSummary) =>
    run(async () => {
      try {
        const { world } = await api.restoreHyperfyWorld(w.id)
        replaceWorld(world)
      } finally {
        refreshSlots()
      }
    })

  const showAdminCode = (w: HyperfyWorldSummary) =>
    run(async () => {
      const { adminCode } = await api.getHyperfyAdminCode(w.id)
      setRevealed({ id: w.id, code: adminCode })
    })

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      // clipboard blocked: the text is still visible to select
    }
  }

  const now = new Date()
  const noSlotsLeft = slots !== null && slots.used >= slots.limit
  const link = (address: string) => (
    <a href={`https://${address}`} target="_blank" rel="noreferrer" className="text-blue-400 hover:text-blue-300">{address}</a>
  )
  const rotatePrompt = (w: HyperfyWorldSummary) => w.kind === 'hosted'
    ? `Make a new key for "${w.name}"? The world restarts to pick it up.`
    : `Make a new key for "${w.name}"? The old key stops working right away.`
  const actionClass = 'text-blue-400 hover:text-blue-300 disabled:opacity-50'
  const dangerClass = 'text-red-400 hover:text-red-300 disabled:opacity-50'

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Your Hyperfy worlds</h2>
        <p className="text-sm text-gray-500">Have VLM host a world for this scene, or connect one you run yourself. Either way it follows your edits.</p>
      </div>

      {error && <p className="rounded-lg border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-300" role="alert">{error}</p>}
      {notice && <p className="rounded-lg border border-blue-900/60 bg-blue-950/40 px-4 py-3 text-sm text-blue-300" role="status">{notice}</p>}

      {shown?.kind === 'key' && (
        <div className="space-y-3 rounded-lg border border-blue-500/40 bg-gray-900 p-5">
          <p className="text-sm font-medium text-blue-400">World key for {shown.worldName}</p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded-md bg-gray-800 px-3 py-2 text-sm text-white">{shown.key}</code>
            <button onClick={() => copy(shown.key)} className="rounded-md bg-gray-800 px-3 py-2 text-sm text-blue-400 hover:bg-gray-700">{copied ? 'Copied' : 'Copy'}</button>
          </div>
          <p className="text-sm text-yellow-400">You won&apos;t see this key again.</p>
          <a href={`${API_URL}/api/hyperfy/app.hyp`} className="inline-block rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">Download VLM app (.hyp)</a>
          <ol className="list-decimal space-y-1 pl-5 text-sm text-gray-300">
            {setupSteps(API_URL).map((step) => <li key={step}>{step}</li>)}
          </ol>
          <button onClick={() => setShown(null)} className="text-sm text-gray-400 hover:text-white">Done</button>
        </div>
      )}

      {shown?.kind === 'created' && (
        <div className="space-y-3 rounded-lg border border-blue-500/40 bg-gray-900 p-5">
          <p className="text-sm font-medium text-blue-400">{shown.worldName} is being set up</p>
          <p className="text-sm text-gray-300">Type <code className="rounded bg-gray-800 px-1.5 py-0.5 text-white">/admin {shown.adminCode}</code> in the world&apos;s chat to build.</p>
          <div>
            <button onClick={() => copy(shown.adminCode)} className="rounded-md bg-gray-800 px-3 py-2 text-sm text-blue-400 hover:bg-gray-700">{copied ? 'Copied' : 'Copy admin code'}</button>
          </div>
          {shown.address && <p className="text-sm text-gray-300">Address: {link(shown.address)}</p>}
          <p className="text-sm text-gray-400">Setup takes about 2 to 3 minutes. The world shows as Live below when it&apos;s ready.</p>
          <p className="text-sm text-yellow-400">Save the admin code now. You can show it again later from the world&apos;s row.</p>
          <button onClick={() => setShown(null)} className="text-sm text-gray-400 hover:text-white">Done</button>
        </div>
      )}

      {loading ? (
        <Skeleton rows={2} className="h-12" />
      ) : worlds.length === 0 ? (
        !error && <p className="rounded-lg border border-gray-800 bg-gray-900 py-6 text-center text-sm text-gray-500">No worlds connected to this scene yet.</p>
      ) : (
        <div className="space-y-2">
          {worlds.map((w) => w.kind === 'hosted' ? (
            <div key={w.id} className="space-y-2 rounded-lg border border-gray-800 bg-gray-900 px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-medium">{w.name}</p>
                  {w.address && <p className="truncate text-sm">{link(w.address)}</p>}
                  <p className="text-xs text-gray-500">
                    {worldStatusLabel(w, now)}
                    {w.status !== 'ended' && w.endsAt && ` · Ends ${shortDate(w.endsAt)}`}
                  </p>
                </div>
                <div className="flex flex-wrap gap-3 text-sm">
                  {w.status !== 'ended' && w.status !== 'failed' && (
                    <button disabled={busy} onClick={() => setEditing({ id: w.id, day: w.endsAt ? w.endsAt.slice(0, 10) : '' })} className={actionClass}>Edit end date</button>
                  )}
                  {w.status !== 'ended' && w.status !== 'failed' && w.endsAt && (
                    <button disabled={busy} onClick={() => saveEndDate(w, null)} className={actionClass}>Make permanent</button>
                  )}
                  {w.status === 'ended' && <button disabled={busy} onClick={() => restore(w)} className={actionClass}>Restore</button>}
                  {w.status === 'running' && <button disabled={busy} onClick={() => showAdminCode(w)} className={actionClass}>Show admin code</button>}
                  {w.status === 'running' && <ConfirmAction disabled={busy} danger={false} confirmLabel="New key" prompt={rotatePrompt(w)} onConfirm={() => rotate(w)} className={actionClass}>New key</ConfirmAction>}
                  <ConfirmAction disabled={busy} confirmLabel="Destroy" prompt={destroyWorldPrompt(w.name)} onConfirm={() => remove(w)} className={dangerClass}>Destroy</ConfirmAction>
                </div>
              </div>
              {editing?.id === w.id && (
                <div className="flex flex-wrap items-end gap-3">
                  <div>
                    <label className="mb-1 block text-xs text-gray-400" htmlFor={`end-${w.id}`}>Ends on</label>
                    <input
                      id={`end-${w.id}`}
                      type="date"
                      value={editing.day}
                      onChange={(e) => setEditing({ id: w.id, day: e.target.value })}
                      className="rounded-md bg-gray-950 px-3 py-2 text-white outline-none focus:border-blue-400 border border-gray-800"
                    />
                  </div>
                  <button disabled={busy || !editing.day} onClick={() => saveEndDate(w, editing.day)} className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">Save</button>
                  <button onClick={() => setEditing(null)} className="text-sm text-gray-400 hover:text-white">Cancel</button>
                </div>
              )}
              {revealed?.id === w.id && (
                <div className="flex flex-wrap items-center gap-2 text-sm text-gray-300">
                  <span>Type <code className="rounded bg-gray-800 px-1.5 py-0.5 text-white">/admin {revealed.code}</code> in the world&apos;s chat to build.</span>
                  <button onClick={() => setRevealed(null)} className="text-gray-400 hover:text-white">Hide</button>
                </div>
              )}
            </div>
          ) : (
            <div key={w.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-800 bg-gray-900 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate font-medium">{w.name}</p>
                <p className="text-xs text-gray-500">Key {w.keyPrefix}… · {lastSeenLabel(w.lastSeenAt, now)}</p>
              </div>
              <div className="flex gap-3 text-sm">
                <ConfirmAction disabled={busy} danger={false} confirmLabel="New key" prompt={rotatePrompt(w)} onConfirm={() => rotate(w)} className={actionClass}>New key</ConfirmAction>
                <ConfirmAction disabled={busy} confirmLabel="Remove" prompt={removeWorldPrompt(w.name)} onConfirm={() => remove(w)} className={dangerClass}>Remove</ConfirmAction>
              </div>
            </div>
          ))}
        </div>
      )}

      {slots?.hostingAvailable && (
        <div className="space-y-3 rounded-lg border border-gray-800 bg-gray-900 p-4">
          <p className="text-sm font-medium">Create a hosted world</p>
          {slotLine(slots.used, slots.limit) && <p className="text-xs text-gray-400">{slotLine(slots.used, slots.limit)}</p>}
          {noSlotsLeft ? (
            <p className="text-sm text-gray-300">
              {noSlotsLine(slots.limit)}{' '}
              <Link href="/settings" className="text-blue-400 hover:text-blue-300">See plans</Link>
            </p>
          ) : (
            <form onSubmit={createHosted} className="flex flex-wrap items-end gap-3">
              <div className="min-w-[12rem] flex-1">
                <label className="mb-1 block text-xs text-gray-400" htmlFor="hosted-name">World name</label>
                <input
                  id="hosted-name"
                  value={hostedName}
                  onChange={(e) => setHostedName(e.target.value)}
                  maxLength={100}
                  placeholder="My hosted world"
                  className="w-full rounded-md bg-gray-950 px-4 py-2 text-white outline-none focus:border-blue-400 border border-gray-800"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-gray-400" htmlFor="hosted-end">Ends on (optional)</label>
                <input
                  id="hosted-end"
                  type="date"
                  value={hostedEnd}
                  onChange={(e) => setHostedEnd(e.target.value)}
                  className="rounded-md bg-gray-950 px-3 py-2 text-white outline-none focus:border-blue-400 border border-gray-800"
                />
              </div>
              <button type="submit" disabled={busy || !hostedName.trim()} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">Create world</button>
            </form>
          )}
        </div>
      )}

      <form onSubmit={connect} className="flex flex-wrap items-end gap-3 rounded-lg border border-gray-800 bg-gray-900 p-4">
        <div className="min-w-[12rem] flex-1">
          <label className="block text-xs text-gray-400 mb-1">Connect a world you run yourself</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={100}
            placeholder="My Hyperfy world"
            className="w-full rounded-md bg-gray-950 px-4 py-2 text-white outline-none focus:border-blue-400 border border-gray-800"
          />
        </div>
        <button type="submit" disabled={busy || !name.trim()} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">Connect a world</button>
      </form>
    </div>
  )
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
  const [newDeployType, setNewDeployType] = useState<'parcel' | 'world'>('parcel')
  const [newParcels, setNewParcels] = useState('')
  const [newContentServer, setNewContentServer] = useState('')
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

  // Action states
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

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
      setDeployments(listedDeployments(data.deployments))
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
      const target: Record<string, unknown> = {}
      if (newParcels.trim()) target.parcels = newParcels.trim()
      if (newContentServer.trim()) target.contentServer = newContentServer.trim()

      const { deployment } = await api.createDeployment({
        sceneId: selectedSceneId,
        platform: 'decentraland',
        deploymentType: newDeployType,
        target,
      })
      setDeployments((prev) => [deployment, ...prev])
      setShowNewDeploy(false)
      resetNewDeployForm()
    } catch (err: any) {
      setDeployError(err.message || 'Deployment failed')
    }
    setDeploying(false)
  }

  const resetNewDeployForm = () => {
    setNewDeployType('parcel')
    setNewParcels('')
    setNewContentServer('')
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
    setActionError(null)
    try {
      const { deployment } = await api.redeployDeployment(id)
      setDeployments((prev) => [deployment, ...prev])
    } catch (err) {
      setActionError(deployErrorMessage(err))
    }
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

  // -- Render -----------------------------------------------------------------

  if (loadingScenes) return <Skeleton />

  return (
    <div className="mx-auto max-w-7xl space-y-8">
      <PageHeader
        crumbs={['Tools', 'Deploy']}
        title="Deploy"
        subtitle="Publish your scenes to their worlds."
        actions={selectedSceneId && (
          <PrimaryButton onClick={() => { setShowNewDeploy(!showNewDeploy); resetNewDeployForm() }}><PlusIcon size={16} /> New Deployment</PrimaryButton>
        )}
      />

      {/* Scene Selector */}
      <div>
        <label className="block text-xs text-gray-400 mb-1">Select Scene</label>
        <select
          value={selectedSceneId}
          onChange={(e) => handleSceneChange(e.target.value)}
          className="w-full max-w-md rounded-md bg-gray-950 px-4 py-2 text-white outline-none focus:border-blue-400 border border-gray-800"
        >
          <option value="">-- Choose a scene --</option>
          {scenes.map((scene) => (
            <option key={scene.id} value={scene.id}>{scene.name}</option>
          ))}
        </select>
      </div>

      {actionError && (
        <p className="rounded-lg border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-300" role="alert">{actionError}</p>
      )}

      {!selectedSceneId && (
        <div className="text-center py-12">
          <p className="text-gray-500 mb-2">Select a scene to view and manage deployments.</p>
          <p className="text-sm text-gray-600">You can deploy scenes to Decentraland, or host a Hyperfy world.</p>
        </div>
      )}

      {/* New Deployment Form */}
      {showNewDeploy && selectedSceneId && (
        <form onSubmit={handleCreateDeployment} className="space-y-4 rounded-lg border border-gray-800 bg-gray-900 p-5">
          <h2 className="text-lg font-semibold">New Deployment</h2>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Deployment Type</label>
              <select
                value={newDeployType}
                onChange={(e) => setNewDeployType(e.target.value as 'parcel' | 'world')}
                className="w-full rounded-md bg-gray-950 px-4 py-2 text-white outline-none focus:border-blue-400 border border-gray-800"
              >
                <option value="parcel">Parcel</option>
                <option value="world">World</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Parcels</label>
                <input
                  type="text"
                  value={newParcels}
                  onChange={(e) => setNewParcels(e.target.value)}
                  placeholder="e.g. 0,0 0,1 1,0 1,1"
                  className="w-full rounded-md bg-gray-950 px-4 py-2 text-white outline-none focus:border-blue-400 border border-gray-800"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Content Server URL</label>
                <input
                  type="text"
                  value={newContentServer}
                  onChange={(e) => setNewContentServer(e.target.value)}
                  placeholder="https://peer.decentraland.org/content"
                  className="w-full rounded-md bg-gray-950 px-4 py-2 text-white outline-none focus:border-blue-400 border border-gray-800"
                />
              </div>
          </div>

          {deployError && <p className="text-sm text-red-400">{deployError}</p>}

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={deploying}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm hover:bg-blue-700 disabled:opacity-50"
            >
              {deploying ? 'Deploying...' : 'Start Deployment'}
            </button>
            <button
              type="button"
              onClick={() => { setShowNewDeploy(false); resetNewDeployForm() }}
              className="rounded-md bg-gray-800 px-4 py-2 text-sm hover:bg-gray-700"
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
            <Skeleton rows={2} className="h-12" />
          ) : deployments.length === 0 ? (
            <div className="text-center py-8 rounded-lg border border-gray-800 bg-gray-900">
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
                />
              ))}
            </div>
          )}
        </div>
      )}

      {selectedSceneId && <HyperfyWorlds sceneId={selectedSceneId} />}

      {/* Deploy Wallets */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">Deploy Wallets</h2>
          <button
            onClick={() => setShowAddWallet(!showAddWallet)}
            className="rounded-md bg-gray-800 px-3 py-1.5 text-xs font-medium hover:bg-gray-700"
          >
            + Add Wallet
          </button>
        </div>

        {showAddWallet && (
          <form onSubmit={handleAddWallet} className="mb-4 space-y-3 rounded-lg border border-gray-800 bg-gray-900 p-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Wallet Address</label>
                <input
                  type="text"
                  value={walletAddress}
                  onChange={(e) => setWalletAddress(e.target.value)}
                  placeholder="0x..."
                  autoFocus
                  className="w-full rounded-md bg-gray-950 px-4 py-2 text-white outline-none focus:border-blue-400 border border-gray-800"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Label (optional)</label>
                <input
                  type="text"
                  value={walletLabel}
                  onChange={(e) => setWalletLabel(e.target.value)}
                  placeholder="My deploy wallet"
                  className="w-full rounded-md bg-gray-950 px-4 py-2 text-white outline-none focus:border-blue-400 border border-gray-800"
                />
              </div>
            </div>
            {walletError && <p className="text-sm text-red-400">{walletError}</p>}
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={addingWallet}
                className="rounded-md bg-blue-600 px-4 py-2 text-sm hover:bg-blue-700 disabled:opacity-50"
              >
                {addingWallet ? 'Adding...' : 'Add Wallet'}
              </button>
              <button
                type="button"
                onClick={() => { setShowAddWallet(false); setWalletError('') }}
                className="rounded-md bg-gray-800 px-4 py-2 text-sm hover:bg-gray-700"
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {loadingWallets ? (
          <Skeleton rows={2} className="h-12" />
        ) : wallets.length === 0 ? (
          <div className="text-center py-6 rounded-lg border border-gray-800 bg-gray-900">
            <p className="text-gray-500 text-sm">No deploy wallets configured.</p>
            <p className="text-xs text-gray-600 mt-1">Add a wallet to deploy to Decentraland.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {wallets.map((wallet) => (
              <div key={wallet.id} className="flex items-center justify-between rounded-lg border border-gray-800 bg-gray-900 px-4 py-3">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-xs font-medium text-gray-400 capitalize">{wallet.platform}</span>
                  <code className="text-sm text-gray-300 font-mono truncate">{wallet.walletAddress}</code>
                  {wallet.label && <span className="text-xs text-gray-500">({wallet.label})</span>}
                  {wallet.hasPrivateKey && (
                    <Badge tone="success">Key stored</Badge>
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
}: {
  deployment: any
  actionLoading: boolean
  onCancel: () => void
  onRedeploy: () => void
}) {
  const target = (deployment.target || {}) as Record<string, any>
  const canCancel = deployment.status === 'pending' || deployment.status === 'building'

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-5 space-y-3">
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
            <a href={target.instanceUrl} target="_blank" rel="noreferrer" className="text-blue-400 hover:text-blue-300 font-mono text-xs truncate block hover:underline">
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
        <div className="rounded-md bg-red-500/10 border border-red-500/20 px-3 py-2">
          <p className="text-sm text-red-400">{deployment.errorMessage}</p>
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-wrap gap-2 pt-1">
        {canCancel && (
          <button
            onClick={onCancel}
            disabled={actionLoading}
            className="rounded-md bg-yellow-600/20 px-3 py-1.5 text-xs text-yellow-400 hover:bg-yellow-600/30 disabled:opacity-50"
          >
            {actionLoading ? 'Cancelling...' : 'Cancel'}
          </button>
        )}
        <button
          onClick={onRedeploy}
          disabled={actionLoading}
          className="rounded-md bg-blue-600/20 px-3 py-1.5 text-xs text-blue-400 hover:bg-blue-600/30 disabled:opacity-50"
        >
          {actionLoading ? 'Redeploying...' : 'Redeploy'}
        </button>
      </div>
    </div>
  )
}
