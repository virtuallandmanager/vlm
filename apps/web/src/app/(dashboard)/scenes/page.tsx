'use client'
import { useApi } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useSearchParams, useRouter } from 'next/navigation'
import { useEffect, useState, Suspense } from 'react'
import Link from 'next/link'
import SceneEditorPage from './[sceneId]/client'
import { ArrowUpRightIcon, CheckIcon, CopyIcon, GridIcon, ListIcon, PencilIcon, PlusIcon, ScenesIcon, SearchIcon } from '@/components/icons'
import { PageHeader, PrimaryButton } from '@/components/ui'
import { countLabel, filterScenes, placeholderHues, shortId } from '@/lib/scenes'

type Scene = { id: string; name: string; description?: string | null; thumbnailUrl?: string | null; relationship?: string }
type View = 'grid' | 'list'

const RELATIONSHIP_LABEL: Record<string, string> = { cohost: 'Co-host', editor: 'Editor', viewer: 'Viewer' }
const VIEW_KEY = 'vlm.scenes.view'
/** Only owners and co-hosts can change a scene's details. */
const canDescribe = (s: Scene) => !s.relationship || s.relationship === 'owner' || s.relationship === 'cohost'

export default function ScenesPage() {
  return (
    <Suspense fallback={<p className="text-gray-400">Loading...</p>}>
      <ScenesContent />
    </Suspense>
  )
}

function ScenesContent() {
  const { token } = useAuth()
  const api = useApi()
  const searchParams = useSearchParams()
  const router = useRouter()
  const selectedSceneId = searchParams.get('id')
  const [scenes, setScenes] = useState<Scene[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [query, setQuery] = useState('')
  const [view, setView] = useState<View>('grid')

  useEffect(() => {
    try {
      const saved = localStorage.getItem(VIEW_KEY)
      if (saved === 'grid' || saved === 'list') setView(saved)
    } catch {
      // no storage: grid
    }
  }, [])
  const chooseView = (v: View) => {
    setView(v)
    try { localStorage.setItem(VIEW_KEY, v) } catch { /* not remembered */ }
  }

  useEffect(() => {
    if (!token) return
    api.getScenes().then(data => { setScenes(data.scenes); setLoading(false) }).catch(() => setLoading(false))
  }, [token])

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newName.trim()) return
    const { scene } = await api.createScene(newName.trim())
    setScenes(prev => [scene, ...prev])
    setNewName('')
    setShowCreate(false)
  }

  const saveDescription = async (id: string, description: string) => {
    const { scene } = await api.updateScene(id, { description })
    setScenes(prev => prev.map(s => (s.id === id ? { ...s, description: scene.description } : s)))
  }

  // Show scene editor when ?id= is present
  if (selectedSceneId) {
    return (
      <div>
        <button onClick={() => router.push('/scenes')}
          className="mb-4 text-sm text-gray-400 hover:text-white">
          ← Back to scenes
        </button>
        <SceneEditorPage />
      </div>
    )
  }

  const shown = filterScenes(scenes, query)

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        crumbs={['Workspace', 'Scenes']}
        title="Scenes"
        count={loading ? undefined : countLabel(scenes.length)}
        subtitle="Manage your virtual worlds."
        actions={<PrimaryButton onClick={() => setShowCreate(!showCreate)}><PlusIcon size={16} /> Create Scene</PrimaryButton>}
      />

      {showCreate && (
        <form onSubmit={handleCreate} className="mb-6 flex flex-wrap gap-2 rounded-lg border border-gray-800 bg-gray-900 p-3">
          <input type="text" value={newName} onChange={e => setNewName(e.target.value)}
            placeholder="Scene name" autoFocus
            className="min-w-48 flex-1 rounded-md border border-gray-800 bg-gray-950 px-4 py-2 text-white outline-none focus:border-blue-400" />
          <button type="submit" className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-700">Create</button>
          <button type="button" onClick={() => setShowCreate(false)} className="rounded-md bg-gray-800 px-4 py-2 text-sm hover:bg-gray-700">Cancel</button>
        </form>
      )}

      {!loading && scenes.length > 0 && (
        <div className="mb-6 flex flex-wrap items-center gap-3">
          <label className="relative min-w-56 flex-1">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-500"><SearchIcon size={18} /></span>
            <span className="sr-only">Search scenes</span>
            <input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search scenes..."
              className="w-full rounded-md border border-gray-800 bg-gray-900 py-2.5 pl-10 pr-3 text-sm outline-none placeholder:text-gray-500 focus:border-blue-400" />
          </label>
          <div className="ml-auto flex items-center gap-3">
          <span className="text-sm text-gray-400">{shown.length} scene{shown.length === 1 ? '' : 's'}</span>
          <div className="flex rounded-md border border-gray-800 bg-gray-900 p-0.5" role="group" aria-label="View">
            {([['grid', GridIcon, 'Grid view'], ['list', ListIcon, 'List view']] as const).map(([v, ViewIcon, label]) => (
              <button key={v} onClick={() => chooseView(v)} aria-label={label} aria-pressed={view === v}
                className={`rounded p-2 transition-colors ${view === v ? 'bg-blue-400/15 text-blue-300' : 'text-gray-500 hover:text-white'}`}>
                <ViewIcon size={18} />
              </button>
            ))}
          </div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2" aria-hidden="true">
          {[0, 1].map(i => <div key={i} className="h-80 animate-pulse rounded-lg border border-gray-800 bg-gray-900" />)}
        </div>
      ) : scenes.length === 0 ? (
        <div className="flex flex-col items-center rounded-lg border border-dashed border-gray-800 px-6 py-16 text-center">
          <span className="mb-4 text-gray-600"><ScenesIcon size={40} /></span>
          <p className="text-lg font-medium">No scenes yet</p>
          <p className="mt-1 mb-6 text-sm text-gray-400">A scene is one of your virtual worlds. Create one to start placing media and running events.</p>
          <PrimaryButton onClick={() => setShowCreate(true)}><PlusIcon size={16} /> Create Scene</PrimaryButton>
        </div>
      ) : shown.length === 0 ? (
        <p className="py-12 text-center text-gray-500">No scenes match “{query.trim()}”.</p>
      ) : view === 'grid' ? (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 min-[1900px]:grid-cols-3">
          {shown.map(scene => <SceneCard key={scene.id} scene={scene} onDescribe={saveDescription} />)}
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-800 bg-gray-900">
          {shown.map((scene, i) => <SceneRow key={scene.id} scene={scene} first={i === 0} />)}
        </div>
      )}
    </div>
  )
}

const sceneHref = (id: string) => `/scenes?id=${id}`

/** The scene's preview image, or a stable two-tone placeholder with its initial. */
function ScenePreview({ scene, className }: { scene: Scene; className: string }) {
  if (scene.thumbnailUrl) return <img src={scene.thumbnailUrl} alt="" className={`${className} object-cover`} />
  const [a, b] = placeholderHues(scene.id)
  return (
    <div className={`${className} relative flex items-center justify-center overflow-hidden`}
      style={{ background: `linear-gradient(135deg, hsl(${a} 45% 16%), hsl(${b} 55% 9%))` }}>
      <div className="absolute inset-0 opacity-[0.12]"
        style={{ backgroundImage: 'linear-gradient(rgba(255,255,255,.6) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.6) 1px, transparent 1px)', backgroundSize: '28px 28px' }} />
      <span className="relative font-mono text-4xl font-semibold text-white/70">{scene.name.trim().charAt(0).toUpperCase() || '?'}</span>
    </div>
  )
}

function CopyId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(id)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard blocked: the id is still visible to select
    }
  }
  return (
    <span className="flex min-w-0 items-center gap-2 font-mono text-xs text-gray-500">
      <span className="truncate" title={id}>ID: {shortId(id)}</span>
      <button onClick={copy} aria-label={copied ? 'Copied' : 'Copy scene ID'} className="shrink-0 rounded p-1 hover:bg-white/[0.05] hover:text-white">
        {copied ? <CheckIcon size={15} className="text-blue-300" /> : <CopyIcon size={15} />}
      </button>
    </span>
  )
}

function RoleBadge({ scene }: { scene: Scene }) {
  if (!scene.relationship || scene.relationship === 'owner') return null
  return <span className="rounded bg-gray-800 px-2 py-0.5 text-xs font-normal text-gray-400">{RELATIONSHIP_LABEL[scene.relationship] ?? scene.relationship}</span>
}

function SceneCard({ scene, onDescribe }: { scene: Scene; onDescribe: (id: string, description: string) => Promise<void> }) {
  return (
    <article className="corner-notch relative flex flex-col overflow-hidden rounded-lg border border-gray-800 bg-gray-900 transition-colors hover:border-gray-700">
      <Link href={sceneHref(scene.id)} tabIndex={-1} aria-hidden="true"><ScenePreview scene={scene} className="h-52 w-full" /></Link>
      <div className="flex-1 px-6 pt-5 pb-4">
        <h2 className="flex flex-wrap items-center gap-2 text-xl font-semibold">
          <Link href={sceneHref(scene.id)} className="hover:text-blue-300">{scene.name}</Link>
          <RoleBadge scene={scene} />
        </h2>
        <Description scene={scene} onSave={onDescribe} />
      </div>
      <footer className="flex items-center justify-between gap-3 border-t border-gray-800 px-6 py-3.5">
        <CopyId id={scene.id} />
        <Link href={sceneHref(scene.id)} className="flex shrink-0 items-center gap-1.5 text-sm text-gray-200 hover:text-blue-300">
          Open scene <ArrowUpRightIcon size={16} />
        </Link>
      </footer>
    </article>
  )
}

/** The description, or (for those who can edit it) an "Add description" action that edits in place. */
function Description({ scene, onSave }: { scene: Scene; onSave: (id: string, description: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (editing) {
    const save = async (e: React.FormEvent) => {
      e.preventDefault()
      setSaving(true)
      setError(null)
      try {
        await onSave(scene.id, draft.trim())
        setEditing(false)
      } catch {
        setError("Couldn't save the description")
      } finally {
        setSaving(false)
      }
    }
    return (
      <form onSubmit={save} className="mt-3">
        <textarea value={draft} onChange={e => setDraft(e.target.value)} rows={2} autoFocus maxLength={500}
          aria-label="Scene description" placeholder="What happens in this scene?"
          className="w-full resize-none rounded-md border border-gray-800 bg-gray-950 px-3 py-2 text-sm outline-none focus:border-blue-400" />
        {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
        <div className="mt-2 flex gap-2">
          <button type="submit" disabled={saving} className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium hover:bg-blue-700 disabled:opacity-50">{saving ? 'Saving…' : 'Save'}</button>
          <button type="button" onClick={() => setEditing(false)} className="rounded-md bg-gray-800 px-3 py-1.5 text-xs hover:bg-gray-700">Cancel</button>
        </div>
      </form>
    )
  }
  if (scene.description) {
    return (
      <p className="group mt-3 line-clamp-2 text-sm text-gray-400">
        {scene.description}
        {canDescribe(scene) && (
          <button onClick={() => { setDraft(scene.description ?? ''); setEditing(true) }} aria-label="Edit description"
            className="ml-2 inline-flex align-middle text-gray-600 opacity-0 hover:text-white group-hover:opacity-100 focus:opacity-100">
            <PencilIcon size={14} />
          </button>
        )}
      </p>
    )
  }
  if (!canDescribe(scene)) return <p className="mt-3 text-sm text-gray-600">No description</p>
  return (
    <button onClick={() => { setDraft(''); setEditing(true) }} className="mt-3 flex items-center gap-2 text-sm text-gray-400 hover:text-white">
      <PencilIcon size={16} /> Add description
    </button>
  )
}

function SceneRow({ scene, first }: { scene: Scene; first: boolean }) {
  return (
    <div className={`flex items-center gap-4 px-4 py-3 ${first ? '' : 'border-t border-gray-800'}`}>
      <Link href={sceneHref(scene.id)} tabIndex={-1} aria-hidden="true" className="shrink-0 overflow-hidden rounded">
        <ScenePreview scene={scene} className="h-12 w-20" />
      </Link>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 font-medium">
          <Link href={sceneHref(scene.id)} className="truncate hover:text-blue-300">{scene.name}</Link>
          <RoleBadge scene={scene} />
        </p>
        <p className="truncate text-sm text-gray-500">{scene.description || 'No description'}</p>
      </div>
      <div className="hidden md:block"><CopyId id={scene.id} /></div>
      <Link href={sceneHref(scene.id)} aria-label={`Open ${scene.name}`} className="shrink-0 rounded p-2 text-gray-400 hover:bg-white/[0.05] hover:text-blue-300">
        <ArrowUpRightIcon size={18} />
      </Link>
    </div>
  )
}
