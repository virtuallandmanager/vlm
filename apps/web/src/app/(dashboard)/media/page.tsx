'use client'
import { useApi } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useEffect, useState, useRef } from 'react'

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

function isImageType(contentType: string): boolean {
  return contentType.startsWith('image/')
}

export default function MediaPage() {
  const { token } = useAuth()
  const api = useApi()
  const [assets, setAssets] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!token) return
    api.getMedia()
      .then(data => { setAssets(data.assets); setLoading(false) })
      .catch(() => setLoading(false))
  }, [token])

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return
    setUploading(true)
    try {
      for (const file of Array.from(files)) {
        const buffer = await file.arrayBuffer()
        const base64 = btoa(
          new Uint8Array(buffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
        )
        const { asset } = await api.uploadMedia(file.name, file.type, base64)
        setAssets(prev => [asset, ...prev])
      }
    } catch (err: any) {
      alert('Upload failed: ' + (err.message || 'Unknown error'))
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleDelete = async (assetId: string) => {
    if (!confirm('Delete this asset?')) return
    try {
      await api.deleteMedia(assetId)
      setAssets(prev => prev.filter(a => a.id !== assetId))
    } catch (err: any) {
      alert('Delete failed: ' + (err.message || 'Unknown error'))
    }
  }

  const handleCopyUrl = (asset: any) => {
    if (asset.publicUrl) {
      navigator.clipboard.writeText(asset.publicUrl)
      setCopied(asset.id)
      setTimeout(() => setCopied(null), 2000)
    }
  }

  if (loading) return <p className="text-gray-400">Loading media...</p>

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Media Library</h1>
        <div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleUpload}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
          >
            {uploading ? 'Uploading...' : '+ Upload File'}
          </button>
        </div>
      </div>

      {assets.length === 0 ? (
        <p className="text-gray-500">No media assets yet. Upload a file to get started.</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {assets.map(asset => (
            <div key={asset.id} className="rounded-xl border border-gray-800 bg-gray-900 overflow-hidden">
              {/* Thumbnail / preview */}
              <div className="h-40 bg-gray-800 flex items-center justify-center overflow-hidden">
                {isImageType(asset.contentType) && asset.publicUrl ? (
                  <img
                    src={asset.publicUrl}
                    alt={asset.filename}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="text-center text-gray-500">
                    <div className="text-3xl mb-1">
                      {asset.contentType.startsWith('video/') ? 'V' :
                       asset.contentType.startsWith('audio/') ? 'A' : 'F'}
                    </div>
                    <div className="text-xs uppercase">{asset.contentType.split('/')[1]}</div>
                  </div>
                )}
              </div>
              {/* Info */}
              <div className="p-3">
                <p className="text-sm font-medium truncate" title={asset.filename}>{asset.filename}</p>
                <p className="text-xs text-gray-500 mt-1">
                  {formatBytes(asset.sizeBytes)} &middot; {asset.contentType}
                </p>
                {/* Actions */}
                <div className="flex gap-2 mt-3">
                  <button
                    onClick={() => handleCopyUrl(asset)}
                    className="flex-1 rounded-lg bg-gray-800 px-3 py-1.5 text-xs hover:bg-gray-700 transition-colors"
                  >
                    {copied === asset.id ? 'Copied!' : 'Copy URL'}
                  </button>
                  <button
                    onClick={() => handleDelete(asset.id)}
                    className="rounded-lg bg-red-900/30 px-3 py-1.5 text-xs text-red-400 hover:bg-red-900/50 transition-colors"
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
