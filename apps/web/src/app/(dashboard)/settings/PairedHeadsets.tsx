'use client'
import { useCallback, useEffect, useState } from 'react'
import type { ArDeviceSummary } from 'vlm-shared'
import { useAuth } from '@/lib/auth'
import { useApi } from '@/lib/api'
import { Skeleton } from '@/components/ui'

const lastUsed = (iso: string | null) => (iso ? `last used ${new Date(iso).toLocaleDateString()}` : 'not used yet')

/** Account settings card: AR headsets paired to this account, each with a Revoke button. */
export function PairedHeadsets() {
  const { token } = useAuth()
  const api = useApi()
  const [headsets, setHeadsets] = useState<ArDeviceSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [revoking, setRevoking] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setHeadsets(await api.getHeadsets())
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
      await api.revokeHeadset(id)
      await load()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setRevoking(null)
    }
  }

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-6">
      <h3 className="text-sm font-medium text-gray-300 mb-1">Paired headsets</h3>
      <p className="text-xs text-gray-500 mb-3">
        AR headsets you approved to sign in to your account. Revoke one to sign it out.
      </p>
      {error && (
        <div className="mb-3 rounded-md bg-red-900/50 border border-red-700 px-4 py-2 text-sm text-red-300">{error}</div>
      )}
      {loading ? (
        <Skeleton rows={2} className="h-12" />
      ) : headsets.length === 0 ? (
        <p className="text-sm text-gray-500">No paired headsets.</p>
      ) : (
        <ul className="space-y-2">
          {headsets.map(h => (
            <li key={h.id} className="flex items-center justify-between gap-3 rounded-md bg-gray-800 px-4 py-2 text-sm">
              <div className="min-w-0">
                <div className="truncate text-gray-200">{h.deviceName ?? 'Headset'}</div>
                <div className="truncate text-xs text-gray-500">{h.kind === 'shared' ? 'Shared' : 'Personal'} · {lastUsed(h.lastUsedAt)}</div>
              </div>
              <button
                type="button"
                onClick={() => revoke(h.id)}
                disabled={revoking === h.id}
                className="shrink-0 rounded-md border border-red-700 px-3 py-1 text-xs text-red-300 hover:bg-red-900/50 disabled:opacity-50 transition-colors"
              >
                {revoking === h.id ? 'Revoking...' : 'Revoke'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
