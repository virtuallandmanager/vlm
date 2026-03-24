'use client'

/**
 * Companion Upload Page — Minimal mobile-friendly file upload.
 *
 * Accessed via short link (e.g., vlm.gg/u/abc123) from a QR code
 * scanned on a phone while the operator is in-world.
 *
 * No login required — the upload code IS the authentication.
 */

import { useState, useEffect, useRef } from 'react'
import { useParams } from 'next/navigation'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3010'

interface TokenInfo {
  valid: boolean
  remainingUploads: number
  expiresAt: string
  sceneId: string | null
}

interface UploadedAsset {
  id: string
  name: string
  cdnUrl: string
  fileSizeBytes: number
}

export default function CompanionUploadPage() {
  const params = useParams()
  const code = params.code as string

  const [tokenInfo, setTokenInfo] = useState<TokenInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploaded, setUploaded] = useState<UploadedAsset[]>([])
  const [remaining, setRemaining] = useState(0)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Validate token on mount
  useEffect(() => {
    fetch(`${API_URL}/api/upload/${code}`)
      .then((res) => {
        if (!res.ok) throw new Error(res.status === 404 ? 'Invalid or expired code' : 'Upload limit reached')
        return res.json()
      })
      .then((data) => {
        setTokenInfo(data)
        setRemaining(data.remainingUploads)
      })
      .catch((err) => setError(err.message))
  }, [code])

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files
    if (!files || files.length === 0) return

    setUploading(true)

    for (const file of Array.from(files)) {
      if (remaining <= 0) break

      try {
        const buffer = await file.arrayBuffer()
        const base64 = btoa(
          new Uint8Array(buffer).reduce((data, byte) => data + String.fromCharCode(byte), ''),
        )

        const res = await fetch(`${API_URL}/api/upload/${code}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            filename: file.name,
            contentType: file.type || 'application/octet-stream',
            fileData: base64,
            name: file.name.replace(/\.[^.]+$/, ''),
          }),
        })

        if (!res.ok) {
          const err = await res.json()
          throw new Error(err.error || 'Upload failed')
        }

        const data = await res.json()
        setUploaded((prev) => [...prev, data.asset])
        setRemaining(data.remainingUploads)
      } catch (err: any) {
        setError(err.message)
      }
    }

    setUploading(false)
    // Reset file input
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  // Error state
  if (error && !tokenInfo) {
    return (
      <div style={styles.container}>
        <div style={styles.card}>
          <h1 style={styles.title}>Upload Link</h1>
          <p style={styles.error}>{error}</p>
          <p style={styles.hint}>This link may have expired or already been used.</p>
        </div>
      </div>
    )
  }

  // Loading
  if (!tokenInfo) {
    return (
      <div style={styles.container}>
        <div style={styles.card}>
          <p style={styles.hint}>Validating upload code...</p>
        </div>
      </div>
    )
  }

  // Main upload UI
  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <h1 style={styles.title}>VLM Upload</h1>
        <p style={styles.subtitle}>
          {remaining > 0
            ? `${remaining} upload${remaining !== 1 ? 's' : ''} remaining`
            : 'Upload limit reached'}
        </p>

        {remaining > 0 && (
          <>
            <label style={styles.uploadButton}>
              {uploading ? 'Uploading...' : 'Choose Files'}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept=".glb,.gltf,.png,.jpg,.jpeg,.webp,.mp4,.webm,.mp3,.wav,.ogg"
                onChange={handleFileSelect}
                disabled={uploading || remaining <= 0}
                style={{ display: 'none' }}
              />
            </label>
            <p style={styles.hint}>
              GLB, images, video, or audio files
            </p>
          </>
        )}

        {error && <p style={styles.error}>{error}</p>}

        {uploaded.length > 0 && (
          <div style={styles.uploadList}>
            <h2 style={styles.listTitle}>Uploaded</h2>
            {uploaded.map((asset) => (
              <div key={asset.id} style={styles.uploadItem}>
                <span style={styles.assetName}>{asset.name}</span>
                <span style={styles.assetSize}>{formatSize(asset.fileSizeBytes)}</span>
              </div>
            ))}
          </div>
        )}

        <p style={styles.footer}>
          Assets will appear in your in-world Asset Browser automatically.
        </p>
      </div>
    </div>
  )
}

// Inline styles for a minimal, mobile-friendly page with no Tailwind dependency
const styles: Record<string, React.CSSProperties> = {
  container: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '1rem',
    background: '#0a0a0f',
  },
  card: {
    width: '100%',
    maxWidth: '400px',
    background: '#1a1a2e',
    borderRadius: '12px',
    padding: '2rem',
    textAlign: 'center',
  },
  title: {
    fontSize: '1.5rem',
    fontWeight: 700,
    marginBottom: '0.25rem',
    color: '#fff',
  },
  subtitle: {
    fontSize: '0.9rem',
    color: '#888',
    marginBottom: '1.5rem',
  },
  uploadButton: {
    display: 'inline-block',
    padding: '0.75rem 2rem',
    background: '#6366f1',
    color: '#fff',
    borderRadius: '8px',
    fontSize: '1rem',
    fontWeight: 600,
    cursor: 'pointer',
    border: 'none',
  },
  hint: {
    fontSize: '0.8rem',
    color: '#666',
    marginTop: '0.75rem',
  },
  error: {
    color: '#ef4444',
    fontSize: '0.9rem',
    marginTop: '0.5rem',
  },
  uploadList: {
    marginTop: '1.5rem',
    textAlign: 'left',
  },
  listTitle: {
    fontSize: '0.85rem',
    fontWeight: 600,
    color: '#888',
    marginBottom: '0.5rem',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
  },
  uploadItem: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '0.5rem 0',
    borderBottom: '1px solid #2a2a3e',
  },
  assetName: {
    fontSize: '0.9rem',
    color: '#e0e0e0',
  },
  assetSize: {
    fontSize: '0.8rem',
    color: '#666',
  },
  footer: {
    fontSize: '0.75rem',
    color: '#555',
    marginTop: '1.5rem',
  },
}
