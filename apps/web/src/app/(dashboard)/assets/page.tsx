'use client'
import { useApi } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useEffect, useState, useRef, useCallback } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

function formatTriangles(count: number): string {
  if (count >= 1_000_000) return (count / 1_000_000).toFixed(1) + 'M'
  if (count >= 1_000) return (count / 1_000).toFixed(1) + 'K'
  return String(count)
}

const LICENSE_LABELS: Record<string, string> = {
  cc0: 'CC0',
  'cc-by': 'CC-BY',
  proprietary: 'Proprietary',
}

// ── Upload Form ─────────────────────────────────────────────────────────────

function UploadForm({ onUploaded }: { onUploaded: (asset: any) => void }) {
  const api = useApi()
  const [open, setOpen] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState('')
  const [tagsInput, setTagsInput] = useState('')
  const [license, setLicense] = useState('cc0')
  const [author, setAuthor] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const reset = () => {
    setName('')
    setDescription('')
    setCategory('')
    setTagsInput('')
    setLicense('cc0')
    setAuthor('')
    setFile(null)
    if (fileRef.current) fileRef.current.value = ''
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!file || !name) return
    setUploading(true)
    try {
      const buffer = await file.arrayBuffer()
      const base64 = btoa(
        new Uint8Array(buffer).reduce((data, byte) => data + String.fromCharCode(byte), ''),
      )
      const tags = tagsInput
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
      const contentType = file.name.endsWith('.gltf') ? 'model/gltf+json' : 'model/gltf-binary'
      const { asset } = await api.uploadAsset({
        name,
        description: description || undefined,
        category: category || undefined,
        tags: tags.length > 0 ? tags : undefined,
        fileData: base64,
        contentType,
        filename: file.name,
        license: license || undefined,
        author: author || undefined,
      })
      onUploaded(asset)
      reset()
      setOpen(false)
    } catch (err: any) {
      alert('Upload failed: ' + (err.message || 'Unknown error'))
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="mb-6">
      <button
        onClick={() => setOpen(!open)}
        className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-700"
      >
        {open ? 'Cancel Upload' : '+ Upload Asset'}
      </button>

      {open && (
        <form onSubmit={handleSubmit} className="mt-4 rounded-xl border border-gray-800 bg-gray-900 p-5 space-y-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <label className="block text-xs text-gray-400 mb-1">File (.glb, .gltf) *</label>
              <input
                ref={fileRef}
                type="file"
                accept=".glb,.gltf"
                onChange={(e) => {
                  const f = e.target.files?.[0] || null
                  setFile(f)
                  if (f && !name) setName(f.name.replace(/\.(glb|gltf)$/i, ''))
                }}
                className="w-full rounded-lg bg-gray-800 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Name *</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Asset name"
                className="w-full rounded-lg bg-gray-800 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs text-gray-400 mb-1">Description</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                placeholder="Optional description"
                className="w-full rounded-lg bg-gray-800 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Category</label>
              <input
                type="text"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="e.g. architecture, nature, furniture"
                className="w-full rounded-lg bg-gray-800 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Tags (comma separated)</label>
              <input
                type="text"
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
                placeholder="modern, outdoor, low-poly"
                className="w-full rounded-lg bg-gray-800 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">License</label>
              <select
                value={license}
                onChange={(e) => setLicense(e.target.value)}
                className="w-full rounded-lg bg-gray-800 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-blue-500"
              >
                <option value="cc0">CC0 (Public Domain)</option>
                <option value="cc-by">CC-BY (Attribution)</option>
                <option value="proprietary">Proprietary</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Author</label>
              <input
                type="text"
                value={author}
                onChange={(e) => setAuthor(e.target.value)}
                placeholder="Author name"
                className="w-full rounded-lg bg-gray-800 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
          </div>
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={uploading || !file || !name}
              className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
            >
              {uploading ? 'Uploading...' : 'Upload'}
            </button>
          </div>
        </form>
      )}
    </div>
  )
}

// ── Asset Detail View ───────────────────────────────────────────────────────

function AssetDetail({ assetId, onBack, onDeleted }: { assetId: string; onBack: () => void; onDeleted: (id: string) => void }) {
  const api = useApi()
  const { token } = useAuth()
  const [asset, setAsset] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [copied, setCopied] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  // Edit state
  const [editName, setEditName] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editCategory, setEditCategory] = useState('')
  const [editTags, setEditTags] = useState('')

  useEffect(() => {
    if (!token) return
    setLoading(true)
    api.getAsset(assetId)
      .then((data) => {
        setAsset(data.asset)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [token, assetId])

  const startEditing = () => {
    if (!asset) return
    setEditName(asset.name)
    setEditDescription(asset.description || '')
    setEditCategory(asset.category || '')
    setEditTags((asset.tags || []).join(', '))
    setEditing(true)
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      const tags = editTags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
      const { asset: updated } = await api.updateAsset(assetId, {
        name: editName,
        description: editDescription || null,
        category: editCategory || null,
        tags: tags.length > 0 ? tags : null,
      })
      setAsset(updated)
      setEditing(false)
    } catch (err: any) {
      alert('Save failed: ' + (err.message || 'Unknown error'))
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    try {
      await api.deleteAsset(assetId)
      onDeleted(assetId)
    } catch (err: any) {
      alert('Delete failed: ' + (err.message || 'Unknown error'))
    }
  }

  const copyUrl = () => {
    if (asset?.cdnUrl) {
      navigator.clipboard.writeText(asset.cdnUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  if (loading) return <p className="text-gray-400">Loading asset...</p>
  if (!asset) return <p className="text-gray-500">Asset not found.</p>

  const dims = asset.dimensions as { width?: number; height?: number; depth?: number } | null

  return (
    <div>
      <button onClick={onBack} className="text-sm text-gray-400 hover:text-white mb-4">
        &larr; Back to Assets
      </button>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Thumbnail */}
        <div className="lg:col-span-1">
          <div className="rounded-xl border border-gray-800 bg-gray-900 overflow-hidden aspect-square flex items-center justify-center">
            {asset.thumbnailUrl ? (
              <img src={asset.thumbnailUrl} alt={asset.name} className="w-full h-full object-cover" />
            ) : (
              <div className="text-center text-gray-500">
                <div className="text-5xl mb-2">&#9651;</div>
                <div className="text-xs">3D Asset</div>
              </div>
            )}
          </div>
        </div>

        {/* Metadata */}
        <div className="lg:col-span-2 space-y-4">
          {editing ? (
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Name</label>
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="w-full rounded-lg bg-gray-800 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Description</label>
                <textarea
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  rows={3}
                  className="w-full rounded-lg bg-gray-800 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Category</label>
                  <input
                    type="text"
                    value={editCategory}
                    onChange={(e) => setEditCategory(e.target.value)}
                    className="w-full rounded-lg bg-gray-800 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Tags (comma separated)</label>
                  <input
                    type="text"
                    value={editTags}
                    onChange={(e) => setEditTags(e.target.value)}
                    className="w-full rounded-lg bg-gray-800 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
                >
                  {saving ? 'Saving...' : 'Save'}
                </button>
                <button
                  onClick={() => setEditing(false)}
                  className="rounded-lg bg-gray-800 px-4 py-2 text-sm hover:bg-gray-700"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-start justify-between">
                <div>
                  <h1 className="text-2xl font-bold">{asset.name}</h1>
                  {asset.description && <p className="text-gray-400 mt-1">{asset.description}</p>}
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={startEditing}
                    className="rounded-lg bg-gray-800 px-3 py-1.5 text-xs hover:bg-gray-700"
                  >
                    Edit
                  </button>
                  {confirmDelete ? (
                    <div className="flex gap-1">
                      <button
                        onClick={handleDelete}
                        className="rounded-lg bg-red-600 px-3 py-1.5 text-xs hover:bg-red-700"
                      >
                        Confirm
                      </button>
                      <button
                        onClick={() => setConfirmDelete(false)}
                        className="rounded-lg bg-gray-800 px-3 py-1.5 text-xs hover:bg-gray-700"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmDelete(true)}
                      className="rounded-lg bg-red-900/30 px-3 py-1.5 text-xs text-red-400 hover:bg-red-900/50"
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>

              {/* Badges row */}
              <div className="flex flex-wrap gap-2">
                {asset.category && (
                  <span className="rounded-full bg-blue-900/40 px-2.5 py-0.5 text-xs text-blue-300">
                    {asset.category}
                  </span>
                )}
                {asset.license && (
                  <span className="rounded-full bg-green-900/40 px-2.5 py-0.5 text-xs text-green-300">
                    {LICENSE_LABELS[asset.license] || asset.license}
                  </span>
                )}
                {asset.tags?.map((tag: string) => (
                  <span key={tag} className="rounded-full bg-gray-800 px-2.5 py-0.5 text-xs text-gray-300">
                    {tag}
                  </span>
                ))}
              </div>

              {/* Stats grid */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div className="rounded-lg bg-gray-900 border border-gray-800 p-3">
                  <p className="text-xs text-gray-500">File Size</p>
                  <p className="text-sm font-medium mt-0.5">{formatBytes(asset.fileSizeBytes)}</p>
                </div>
                {asset.triangleCount != null && (
                  <div className="rounded-lg bg-gray-900 border border-gray-800 p-3">
                    <p className="text-xs text-gray-500">Triangles</p>
                    <p className="text-sm font-medium mt-0.5">{formatTriangles(asset.triangleCount)}</p>
                  </div>
                )}
                {asset.textureCount != null && (
                  <div className="rounded-lg bg-gray-900 border border-gray-800 p-3">
                    <p className="text-xs text-gray-500">Textures</p>
                    <p className="text-sm font-medium mt-0.5">{asset.textureCount}</p>
                  </div>
                )}
                {asset.materialCount != null && (
                  <div className="rounded-lg bg-gray-900 border border-gray-800 p-3">
                    <p className="text-xs text-gray-500">Materials</p>
                    <p className="text-sm font-medium mt-0.5">{asset.materialCount}</p>
                  </div>
                )}
                {dims && (
                  <div className="rounded-lg bg-gray-900 border border-gray-800 p-3">
                    <p className="text-xs text-gray-500">Dimensions</p>
                    <p className="text-sm font-medium mt-0.5">
                      {dims.width?.toFixed(1)} x {dims.height?.toFixed(1)} x {dims.depth?.toFixed(1)}
                    </p>
                  </div>
                )}
                {asset.author && (
                  <div className="rounded-lg bg-gray-900 border border-gray-800 p-3">
                    <p className="text-xs text-gray-500">Author</p>
                    <p className="text-sm font-medium mt-0.5">{asset.author}</p>
                  </div>
                )}
              </div>

              {/* CDN URL */}
              {asset.cdnUrl && (
                <div>
                  <p className="text-xs text-gray-500 mb-1">CDN URL</p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 rounded-lg bg-gray-800 px-3 py-2 text-xs text-gray-300 truncate block">
                      {asset.cdnUrl}
                    </code>
                    <button
                      onClick={copyUrl}
                      className="rounded-lg bg-gray-800 px-3 py-2 text-xs hover:bg-gray-700 whitespace-nowrap"
                    >
                      {copied ? 'Copied!' : 'Copy'}
                    </button>
                  </div>
                </div>
              )}

              {/* Storage key */}
              <div>
                <p className="text-xs text-gray-500 mb-1">Storage Key</p>
                <code className="rounded-lg bg-gray-800 px-3 py-2 text-xs text-gray-400 block">
                  {asset.storageKey}
                </code>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Main Page ───────────────────────────────────────────────────────────────

export default function AssetsPage() {
  const { token } = useAuth()
  const api = useApi()
  const router = useRouter()
  const searchParams = useSearchParams()
  const selectedId = searchParams.get('id')

  const [assets, setAssets] = useState<any[]>([])
  const [total, setTotal] = useState(0)
  const [categories, setCategories] = useState<string[]>([])
  const [loading, setLoading] = useState(true)

  // Filters
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('')
  const [tagFilter, setTagFilter] = useState('')

  const fetchAssets = useCallback(async () => {
    setLoading(true)
    try {
      const params: Record<string, string> = {}
      if (search) params.q = search
      if (categoryFilter) params.category = categoryFilter
      if (tagFilter) params.tag = tagFilter
      const data = await api.getAssets(params)
      setAssets(data.assets)
      setTotal(data.total)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [search, categoryFilter, tagFilter, token])

  const fetchCategories = useCallback(async () => {
    try {
      const data = await api.getAssetCategories()
      setCategories(data.categories)
    } catch {
      // ignore
    }
  }, [token])

  useEffect(() => {
    if (!token) return
    fetchAssets()
  }, [token, search, categoryFilter, tagFilter])

  useEffect(() => {
    if (!token) return
    fetchCategories()
  }, [token])

  // Debounced search
  const [searchInput, setSearchInput] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), 300)
    return () => clearTimeout(t)
  }, [searchInput])

  const handleUploaded = (asset: any) => {
    setAssets((prev) => [asset, ...prev])
    setTotal((prev) => prev + 1)
    // Refresh categories in case new one was added
    fetchCategories()
  }

  const handleDeleted = (id: string) => {
    setAssets((prev) => prev.filter((a) => a.id !== id))
    setTotal((prev) => prev - 1)
    router.push('/assets')
  }

  // ── Detail view ───────────────────────────────────────────────────────────
  if (selectedId) {
    return (
      <AssetDetail
        assetId={selectedId}
        onBack={() => router.push('/assets')}
        onDeleted={handleDeleted}
      />
    )
  }

  // ── List view ─────────────────────────────────────────────────────────────
  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">3D Asset Library</h1>
        <span className="text-sm text-gray-500">{total} asset{total !== 1 ? 's' : ''}</span>
      </div>

      <UploadForm onUploaded={handleUploaded} />

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-6">
        <input
          type="text"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search assets..."
          className="rounded-lg bg-gray-800 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-blue-500 w-64"
        />
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="rounded-lg bg-gray-800 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-blue-500"
        >
          <option value="">All Categories</option>
          {categories.map((cat) => (
            <option key={cat} value={cat}>
              {cat}
            </option>
          ))}
        </select>
        <input
          type="text"
          value={tagFilter}
          onChange={(e) => setTagFilter(e.target.value)}
          placeholder="Filter by tag..."
          className="rounded-lg bg-gray-800 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-blue-500 w-40"
        />
        {(search || categoryFilter || tagFilter) && (
          <button
            onClick={() => {
              setSearchInput('')
              setSearch('')
              setCategoryFilter('')
              setTagFilter('')
            }}
            className="rounded-lg bg-gray-800 px-3 py-2 text-sm text-gray-400 hover:text-white hover:bg-gray-700"
          >
            Clear Filters
          </button>
        )}
      </div>

      {loading ? (
        <p className="text-gray-400">Loading assets...</p>
      ) : assets.length === 0 ? (
        <div className="text-center py-16">
          <div className="text-4xl text-gray-600 mb-3">&#9651;</div>
          <p className="text-gray-500">
            {search || categoryFilter || tagFilter
              ? 'No assets match your filters.'
              : 'No 3D assets yet. Upload one to get started.'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {assets.map((asset) => (
            <button
              key={asset.id}
              onClick={() => router.push(`/assets?id=${asset.id}`)}
              className="text-left rounded-xl border border-gray-800 bg-gray-900 overflow-hidden hover:border-gray-700 transition-colors"
            >
              {/* Thumbnail */}
              <div className="h-40 bg-gray-800 flex items-center justify-center overflow-hidden">
                {asset.thumbnailUrl ? (
                  <img
                    src={asset.thumbnailUrl}
                    alt={asset.name}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="text-center text-gray-500">
                    <div className="text-4xl mb-1">&#9651;</div>
                    <div className="text-xs">3D Asset</div>
                  </div>
                )}
              </div>
              {/* Info */}
              <div className="p-3">
                <p className="text-sm font-medium truncate" title={asset.name}>
                  {asset.name}
                </p>
                <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                  {asset.category && (
                    <span className="rounded-full bg-blue-900/40 px-2 py-0.5 text-[10px] text-blue-300">
                      {asset.category}
                    </span>
                  )}
                  {asset.license && (
                    <span className="rounded-full bg-green-900/40 px-2 py-0.5 text-[10px] text-green-300">
                      {LICENSE_LABELS[asset.license] || asset.license}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3 mt-2 text-xs text-gray-500">
                  <span>{formatBytes(asset.fileSizeBytes)}</span>
                  {asset.triangleCount != null && (
                    <span>{formatTriangles(asset.triangleCount)} tris</span>
                  )}
                  {asset.author && <span className="truncate">{asset.author}</span>}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
