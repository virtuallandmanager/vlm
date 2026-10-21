'use client'
import { useCallback, useEffect, useState } from 'react'
import type { HyperfyPairingSummary } from 'vlm-shared'
import { useAuth } from '@/lib/auth'
import { useApi } from '@/lib/api'
import { pairingRowLabel } from '@/lib/pairing'

/** Account settings card: Hyperfy worlds paired to this account, each with a Revoke button. */
export function LinkedHyperfySessions() {
  const { token } = useAuth()
  const api = useApi()
  const [pairings, setPairings] = useState<HyperfyPairingSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [revoking, setRevoking] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setPairings((await api.getHyperfyPairings()).pairings)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
    // useApi() returns new functions every render; reload only when the session changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  useEffect(() => { load() }, [load])

  const revoke = async (id: string) => {
    setError(null)
    setRevoking(id)
    try {
      await api.revokeHyperfyPairing(id)
      await load()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setRevoking(null)
    }
  }

  const now = new Date()
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-6">
      <h3 className="text-sm font-medium text-gray-300 mb-1">Linked Hyperfy sessions</h3>
      <p className="text-xs text-gray-500 mb-3">
        Hyperfy worlds you approved to edit your scenes from the VLM HUD. Revoke one to sign that world out.
      </p>
      {error && (
        <div className="mb-3 rounded-lg bg-red-900/50 border border-red-700 px-4 py-2 text-sm text-red-300">{error}</div>
      )}
      {loading ? (
        <p className="text-sm text-gray-500">Loading...</p>
      ) : pairings.length === 0 ? (
        <p className="text-sm text-gray-500">No linked Hyperfy sessions.</p>
      ) : (
        <ul className="space-y-2">
          {pairings.map(p => (
            <li key={p.id} className="flex items-center justify-between gap-3 rounded-lg bg-gray-800 px-4 py-2 text-sm">
              <div className="min-w-0">
                <div className="truncate text-gray-200">{pairingRowLabel(p, now)}</div>
                <div className="truncate text-xs text-gray-500">Scene {p.sceneName}</div>
              </div>
              <button
                type="button"
                onClick={() => revoke(p.id)}
                disabled={revoking === p.id}
                className="shrink-0 rounded-lg border border-red-700 px-3 py-1 text-xs text-red-300 hover:bg-red-900/50 disabled:opacity-50 transition-colors"
              >
                {revoking === p.id ? 'Revoking...' : 'Revoke'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
