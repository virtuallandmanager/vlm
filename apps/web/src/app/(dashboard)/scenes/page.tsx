'use client'
import { useApi } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useSearchParams, useRouter } from 'next/navigation'
import { useEffect, useState, Suspense } from 'react'
import SceneEditorPage from './[sceneId]/client'

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
  const [scenes, setScenes] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')

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

  if (loading) return <p className="text-gray-400">Loading scenes...</p>

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Scenes</h1>
        <button onClick={() => setShowCreate(!showCreate)}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-700">
          + Create Scene
        </button>
      </div>

      {showCreate && (
        <form onSubmit={handleCreate} className="mb-6 flex gap-2">
          <input type="text" value={newName} onChange={e => setNewName(e.target.value)}
            placeholder="Scene name" autoFocus
            className="flex-1 rounded-lg bg-gray-800 px-4 py-2 text-white outline-none focus:ring-2 focus:ring-blue-500" />
          <button type="submit" className="rounded-lg bg-blue-600 px-4 py-2 text-sm hover:bg-blue-700">Create</button>
          <button type="button" onClick={() => setShowCreate(false)} className="rounded-lg bg-gray-800 px-4 py-2 text-sm hover:bg-gray-700">Cancel</button>
        </form>
      )}

      {scenes.length === 0 ? (
        <p className="text-gray-500">No scenes yet. Create one to get started.</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {scenes.map(scene => (
            <button key={scene.id} onClick={() => router.push(`/scenes?id=${scene.id}`)}
              className="rounded-xl border border-gray-800 bg-gray-900 p-4 hover:border-gray-600 transition-colors text-left">
              <h3 className="font-semibold">{scene.name}</h3>
              <p className="mt-1 text-sm text-gray-400">{scene.description || 'No description'}</p>
              <p className="mt-2 text-xs text-gray-600">ID: {scene.id}</p>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
