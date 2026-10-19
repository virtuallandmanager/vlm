'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import type { CatalogPack } from 'vlm-shared'
import { useAuth } from '@/lib/auth'
import { useApi } from '@/lib/api'
import { licenseLabel } from '@/lib/catalog'

/** Admin: switch catalog packs on and off. Off hides a pack from browsing and new picks; placed models stay. */
export default function CatalogPacksPage() {
  const { user } = useAuth()
  const api = useApi()
  const [packs, setPacks] = useState<CatalogPack[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    if (user?.role !== 'admin') return
    api.getAdminCatalogPacks().then((d) => setPacks(d.packs), (e) => setError(e.message))
  }, [user?.role])

  const toggle = async (p: CatalogPack) => {
    setBusy(p.id)
    setError(null)
    try {
      const { pack } = await api.setCatalogPackEnabled(p.id, !p.enabled)
      setPacks((prev) => prev?.map((x) => (x.id === pack.id ? pack : x)) ?? null)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(null)
    }
  }

  if (user?.role !== 'admin') return <p className="text-gray-400">Admin access required.</p>
  const models = packs?.reduce((n, p) => n + (p.enabled ? p.modelCount : 0), 0) ?? 0

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <Link href="/admin" className="text-sm text-gray-400 hover:text-white">&larr; Admin</Link>
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-bold">Catalog packs</h1>
        {packs && <span className="text-sm text-gray-500">{models} models available</span>}
      </div>
      <p className="text-sm text-gray-400">
        Turning a pack off hides its models from the catalog and stops new adds right away. Models already in scenes keep working.
      </p>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {!packs ? (
        <p className="text-gray-400">Loading packs…</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-800">
          <table className="w-full text-sm">
            <thead className="bg-gray-900 text-left text-xs text-gray-500">
              <tr><th className="p-3">Pack</th><th className="p-3">Source</th><th className="p-3">License</th><th className="p-3 text-right">Models</th><th className="p-3 text-right">Available</th></tr>
            </thead>
            <tbody>
              {packs.map((p) => (
                <tr key={p.id} className="border-t border-gray-800">
                  <td className="p-3">{p.name}<div className="text-[10px] text-gray-600">{p.id}</div></td>
                  <td className="p-3 text-gray-400"><a href={p.sourceUrl} target="_blank" rel="noreferrer" className="hover:text-white">{p.source}</a></td>
                  <td className="p-3 text-gray-400">{licenseLabel(p.license)}</td>
                  <td className="p-3 text-right text-gray-400">{p.modelCount}</td>
                  <td className="p-3 text-right">
                    <button
                      onClick={() => toggle(p)}
                      disabled={busy === p.id}
                      aria-pressed={p.enabled}
                      className={`rounded-full px-3 py-1 text-xs disabled:opacity-50 ${p.enabled ? 'bg-green-700 hover:bg-green-600' : 'bg-gray-700 hover:bg-gray-600'}`}
                    >
                      {p.enabled ? 'On' : 'Off'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
