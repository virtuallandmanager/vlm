'use client'

import { useEffect, useState } from 'react'
import { AD_SHAPES } from 'vlm-shared'
import type { AdminAd, AdReport, AdShape, LevelCounts } from 'vlm-shared'
import { useAuth } from '@/lib/auth'
import { useApi, fileToBase64, mediaContentType, uploadErrorMessage } from '@/lib/api'
import type { AdminAdSpace } from '@/lib/api'
import { shapeLabel, isHttpsUrl, clickRate } from '@/lib/ads'
import { PageHeader, PrimaryButton } from '@/components/ui'
import { PlusIcon } from '@/components/icons'

const ERRORS: Record<string, string> = {
  click_url_must_be_https: 'The click URL must start with https://',
  house_ads_go_everywhere: 'House ads run everywhere, so they have no placements.',
  media_not_ready: 'That file is still processing. Try again in a moment.',
  elements_must_be_ad_spaces: 'Ads can only be placed on ad spaces and on screens in an ads mode.',
}
const errorText = (e: any): string => ERRORS[e?.message] ?? e?.message ?? 'Something went wrong'

const fmt = new Intl.NumberFormat('en-US')

/** Admin: create ads, attach creatives per shape, place them on ad spaces, and read the numbers. */
export default function AdminAdsPage() {
  const { user } = useAuth()
  const api = useApi()
  const [ads, setAds] = useState<AdminAd[] | null>(null)
  const [spaces, setSpaces] = useState<AdminAdSpace[]>([])
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)

  useEffect(() => {
    if (user?.role !== 'admin') return
    api.getAdminAds().then((d) => setAds(d.ads), (e) => setError(errorText(e)))
    api.getAdminAdSpaces().then((d) => setSpaces(d.spaces), (e) => setError(errorText(e)))
  }, [user?.role])

  const replaceAd = (ad: AdminAd) => setAds((prev) => prev?.map((a) => (a.id === ad.id ? ad : a)) ?? null)

  if (user?.role !== 'admin') return <p className="text-gray-400">Admin access required.</p>

  return (
    <div className="max-w-5xl mx-auto">
      <PageHeader
        crumbs={['Admin', 'Ads']}
        title="Ads"
        count={ads ? String(ads.length) : undefined}
        subtitle="Partner ads run on the spaces you place them on. House ads fill any space with no partner ad and pay nothing."
        actions={<PrimaryButton onClick={() => setCreating((v) => !v)}><PlusIcon size={16} />New ad</PrimaryButton>}
      />
      {error && <p className="mb-4 text-sm text-red-400">{error}</p>}
      {creating && (
        <NewAdForm
          onCreated={(ad) => { setAds((prev) => [...(prev ?? []), ad]); setCreating(false); setOpenId(ad.id) }}
          onCancel={() => setCreating(false)}
        />
      )}
      {!ads ? (
        <p className="text-gray-400">Loading ads…</p>
      ) : ads.length === 0 ? (
        <p className="py-8 text-center text-sm text-gray-500">No ads yet.</p>
      ) : (
        <div className="space-y-3">
          {ads.map((ad) => (
            <AdCard key={ad.id} ad={ad} spaces={spaces} open={openId === ad.id}
              onToggle={() => setOpenId(openId === ad.id ? null : ad.id)} onChange={replaceAd} />
          ))}
        </div>
      )}
    </div>
  )
}

function NewAdForm({ onCreated, onCancel }: { onCreated: (ad: AdminAd) => void; onCancel: () => void }) {
  const api = useApi()
  const [name, setName] = useState('')
  const [kind, setKind] = useState<'house' | 'partner'>('partner')
  const [clickUrl, setClickUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const valid = name.trim() !== '' && isHttpsUrl(clickUrl)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const { ad } = await api.createAdminAd({ name: name.trim(), kind, clickUrl })
      onCreated(ad)
    } catch (err: any) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="mb-4 space-y-3 rounded-xl border border-gray-800 bg-gray-900 p-4">
      <div className="flex flex-wrap gap-3">
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs text-gray-500">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120}
            className="rounded bg-gray-800 px-3 py-1.5 text-sm text-white outline-none focus:ring-1 focus:ring-blue-500" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-gray-500">
          Kind
          <select value={kind} onChange={(e) => setKind(e.target.value as 'house' | 'partner')}
            className="rounded bg-gray-800 px-3 py-1.5 text-sm text-white outline-none focus:ring-1 focus:ring-blue-500">
            <option value="partner">Partner</option>
            <option value="house">House</option>
          </select>
        </label>
      </div>
      <label className="flex flex-col gap-1 text-xs text-gray-500">
        Click URL
        <input value={clickUrl} onChange={(e) => setClickUrl(e.target.value)} placeholder="https://"
          className="rounded bg-gray-800 px-3 py-1.5 text-sm text-white outline-none focus:ring-1 focus:ring-blue-500" />
        {clickUrl !== '' && !isHttpsUrl(clickUrl) && <span className="text-red-400">Must be a full https:// address.</span>}
      </label>
      {error && <p className="text-sm text-red-400">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={!valid || busy}
          className="rounded bg-gray-700 px-3 py-1.5 text-sm text-white hover:bg-gray-600 disabled:opacity-50">
          {busy ? 'Creating…' : 'Create ad'}
        </button>
        <button type="button" onClick={onCancel} className="px-3 py-1.5 text-sm text-gray-400 hover:text-white">Cancel</button>
      </div>
    </form>
  )
}

function AdCard({ ad, spaces, open, onToggle, onChange }: {
  ad: AdminAd
  spaces: AdminAdSpace[]
  open: boolean
  onToggle: () => void
  onChange: (ad: AdminAd) => void
}) {
  const api = useApi()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const paused = ad.status === 'paused'

  const toggleStatus = async () => {
    setBusy(true)
    setError(null)
    try {
      const { ad: next } = await api.updateAdminAd(ad.id, { status: paused ? 'active' : 'paused' })
      onChange(next)
    } catch (e: any) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900">
      <div className="flex flex-wrap items-center justify-between gap-3 p-4">
        <button onClick={onToggle} aria-expanded={open} className="min-w-0 flex-1 text-left">
          <div className="flex items-center gap-2">
            <span className="truncate font-semibold">{ad.name}</span>
            <span className="rounded bg-gray-800 px-2 py-0.5 text-xs text-gray-400">{ad.kind === 'house' ? 'House' : 'Partner'}</span>
            {paused && <span className="rounded bg-gray-800 px-2 py-0.5 text-xs text-yellow-400">Paused</span>}
          </div>
          <div className="mt-1 truncate text-xs text-gray-500">
            {ad.creatives.length} creative{ad.creatives.length !== 1 ? 's' : ''}
            {ad.kind === 'partner' && ` · ${ad.placements.length} placement${ad.placements.length !== 1 ? 's' : ''}`} · {ad.clickUrl}
          </div>
        </button>
        <button onClick={toggleStatus} disabled={busy}
          className="rounded bg-gray-700 px-3 py-1.5 text-sm text-white hover:bg-gray-600 disabled:opacity-50">
          {paused ? 'Resume' : 'Pause'}
        </button>
      </div>
      {error && <p className="px-4 pb-3 text-sm text-red-400">{error}</p>}
      {open && (
        <div className="space-y-6 border-t border-gray-800 p-4">
          <Creatives ad={ad} onChange={onChange} />
          {ad.kind === 'partner' && <Placements ad={ad} spaces={spaces} onChange={onChange} />}
          <Report adId={ad.id} />
        </div>
      )}
    </div>
  )
}

function Creatives({ ad, onChange }: { ad: AdminAd; onChange: (ad: AdminAd) => void }) {
  const api = useApi()
  const [shape, setShape] = useState<AdShape>('16:9')
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const upload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target
    const file = input.files?.[0]
    if (!file) return
    setUploading(true)
    setError(null)
    try {
      const { asset } = await api.uploadMedia(file.name, mediaContentType(file), await fileToBase64(file))
      const { creative } = await api.addAdminAdCreative(ad.id, asset.id, shape)
      onChange({ ...ad, creatives: [...ad.creatives, creative] })
    } catch (err: any) {
      setError(ERRORS[err?.message] ?? uploadErrorMessage(err))
    } finally {
      setUploading(false)
      input.value = ''
    }
  }

  const remove = async (creativeId: string) => {
    setError(null)
    try {
      await api.deleteAdminAdCreative(ad.id, creativeId)
      onChange({ ...ad, creatives: ad.creatives.filter((c) => c.id !== creativeId) })
    } catch (err: any) {
      setError(errorText(err))
    }
  }

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold text-gray-300">Creatives</h3>
      <p className="text-xs text-gray-500">An ad only shows in a space with its exact shape. Add one creative per shape you want to cover.</p>
      {ad.creatives.length > 0 && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {ad.creatives.map((c) => (
            <div key={c.id} className="space-y-1 rounded-lg border border-gray-800 bg-gray-950 p-2">
              <div className="flex h-24 items-center justify-center overflow-hidden rounded bg-gray-800">
                {c.kind === 'image'
                  ? <img src={c.url} alt={`${ad.name} ${c.shape}`} className="max-h-full max-w-full object-contain" />
                  : <video src={c.url} muted preload="metadata" className="max-h-full max-w-full object-contain" />}
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-400">{shapeLabel(c.shape)} · {c.kind}</span>
                <button onClick={() => remove(c.id)} className="text-gray-500 hover:text-red-400">Remove</button>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <select value={shape} onChange={(e) => setShape(e.target.value as AdShape)} aria-label="Creative shape"
          className="rounded bg-gray-800 px-3 py-1.5 text-sm text-white outline-none focus:ring-1 focus:ring-blue-500">
          {AD_SHAPES.map((s) => <option key={s} value={s}>{shapeLabel(s)}</option>)}
        </select>
        <label className={`cursor-pointer rounded bg-gray-700 px-3 py-1.5 text-sm text-white transition-colors hover:bg-gray-600 ${uploading ? 'pointer-events-none opacity-50' : ''}`}>
          {uploading ? 'Uploading…' : 'Upload image or video'}
          <input type="file" accept="image/*,video/mp4,video/webm" onChange={upload} className="hidden" />
        </label>
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
    </section>
  )
}

function Placements({ ad, spaces, onChange }: { ad: AdminAd; spaces: AdminAdSpace[]; onChange: (ad: AdminAd) => void }) {
  const api = useApi()
  const [selected, setSelected] = useState<Set<string>>(() => new Set(ad.placements))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dirty = selected.size !== ad.placements.length || ad.placements.some((id) => !selected.has(id))

  // one group per scene preset, e.g. "Ship · Default (active)"
  const byPreset = new Map<string, AdminAdSpace[]>()
  for (const s of spaces) {
    const group = `${s.sceneName} · ${s.presetName}${s.activePreset ? ' (active)' : ''}`
    byPreset.set(group, [...(byPreset.get(group) ?? []), s])
  }
  const covered = new Set(ad.creatives.map((c) => c.shape))

  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev)
    if (!next.delete(id)) next.add(id)
    return next
  })

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const { ad: next } = await api.setAdminAdPlacements(ad.id, [...selected])
      onChange(next)
    } catch (err: any) {
      setError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold text-gray-300">Placements</h3>
      {spaces.length === 0 ? (
        <p className="text-sm text-gray-500">No ad spaces exist yet. Add an Ad space in a scene, or switch a video screen to Ads.</p>
      ) : (
        <div className="max-h-72 space-y-3 overflow-y-auto rounded-lg border border-gray-800 p-3">
          {[...byPreset].map(([group, list]) => (
            <div key={group}>
              <p className="mb-1 text-xs text-gray-500">{group}</p>
              {list.map((s) => (
                <label key={s.elementId} className="flex items-center gap-2 py-0.5 text-sm">
                  <input type="checkbox" checked={selected.has(s.elementId)} onChange={() => toggle(s.elementId)} className="accent-blue-500" />
                  <span>{s.name}</span>
                  <span className="text-xs text-gray-500">
                    {s.type === 'video' ? 'Screen' : 'Ad space'} · {s.shape ? shapeLabel(s.shape) : 'Unknown shape'}
                  </span>
                  {s.shape && !covered.has(s.shape) && <span className="text-xs text-yellow-400">no creative for this shape</span>}
                </label>
              ))}
            </div>
          ))}
        </div>
      )}
      {error && <p className="text-sm text-red-400">{error}</p>}
      <button onClick={save} disabled={!dirty || saving}
        className="rounded bg-gray-700 px-3 py-1.5 text-sm text-white hover:bg-gray-600 disabled:opacity-50">
        {saving ? 'Saving…' : 'Save placements'}
      </button>
    </section>
  )
}

function Report({ adId }: { adId: string }) {
  const api = useApi()
  const [report, setReport] = useState<AdReport | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.getAdminAdReport(adId).then(setReport, (e) => setError(errorText(e)))
  }, [adId])

  if (error) return <p className="text-sm text-red-400">{error}</p>
  if (!report) return <p className="text-sm text-gray-500">Loading report…</p>
  const t = report.totals

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold text-gray-300">Report</h3>
      <p className="text-xs text-gray-500">
        Paid numbers count verified wallets, once per day per level. Unverified players and guests are shown separately and are not paid.
      </p>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="In scene" value={fmt.format(t.scene)} sub={`${fmt.format(t.unverified.scene)} unverified`} />
        <Stat label="On screen (paid)" value={fmt.format(t.screen)} sub={`${fmt.format(t.unverified.screen)} unverified`} />
        <Stat label="Looked at" value={fmt.format(t.look)} sub={report.avgLookMs === null ? 'no look time yet' : `avg ${(report.avgLookMs / 1000).toFixed(1)}s`} />
        <Stat label="Clicks" value={fmt.format(t.click)} sub={`${fmt.format(t.unverified.click)} unverified`} />
        <Stat label="Click rate" value={clickRate(t)} sub="clicks ÷ on screen" />
      </div>
      {report.bySpace.length > 0 && (
        <CountsTable title="By space" rows={report.bySpace.map((r) => ({ key: r.elementId, label: `${r.sceneName}`, counts: r }))} />
      )}
      {report.byDay.length > 0 && (
        <CountsTable title="By day" rows={report.byDay.map((r) => ({ key: r.day, label: r.day, counts: r }))} />
      )}
    </section>
  )
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-950 p-3">
      <p className="text-xs text-gray-500">{label}</p>
      <p className="text-xl font-semibold">{value}</p>
      <p className="text-xs text-gray-500">{sub}</p>
    </div>
  )
}

function CountsTable({ title, rows }: { title: string; rows: { key: string; label: string; counts: LevelCounts }[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-800">
      <table className="w-full text-sm">
        <thead className="bg-gray-950 text-left text-xs text-gray-500">
          <tr>
            <th className="p-2">{title}</th>
            <th className="p-2 text-right">In scene</th>
            <th className="p-2 text-right">On screen</th>
            <th className="p-2 text-right">Looked</th>
            <th className="p-2 text-right">Clicks</th>
            <th className="p-2 text-right">Click rate</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-t border-gray-800">
              <td className="p-2">{r.label}</td>
              <td className="p-2 text-right text-gray-400">{fmt.format(r.counts.scene)}</td>
              <td className="p-2 text-right text-gray-400">{fmt.format(r.counts.screen)}</td>
              <td className="p-2 text-right text-gray-400">{fmt.format(r.counts.look)}</td>
              <td className="p-2 text-right text-gray-400">{fmt.format(r.counts.click)}</td>
              <td className="p-2 text-right text-gray-400">{clickRate(r.counts)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
