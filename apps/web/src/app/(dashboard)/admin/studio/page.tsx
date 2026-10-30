'use client'

import { useEffect, useState } from 'react'
import { useAuth } from '@/lib/auth'
import { useApi } from '@/lib/api'
import { Badge, ConfirmAction, PageHeader, PrimaryButton, Skeleton } from '@/components/ui'
import { SCOPE_CATEGORY_WORDS, flagSummary, formatCents, type AdminMistakeReport, type AdminStudioFlag } from '@/lib/studio'

const dateFmt = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' })

/**
 * Admin: accounts the studio flagged for repeatedly sending work that isn't a design (dismiss, or pause their studio
 * access), and mistake reports past a piece's instant refunds (approve or decline).
 */
export default function AdminStudioPage() {
  const { user } = useAuth()
  const api = useApi()
  const [status, setStatus] = useState<'open' | 'closed'>('open')
  const [flags, setFlags] = useState<AdminStudioFlag[] | null>(null)
  const [reports, setReports] = useState<AdminMistakeReport[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // useApi gives a new object each render, so the effect keys on the role and the tab, not on load itself
  const load = async () => {
    try {
      const [f, r] = await Promise.all([api.getAdminStudioFlags(status), api.getAdminStudioReports()])
      setFlags(f.flags)
      setReports(r.reports)
      setError(null)
    } catch (e) {
      setError((e as Error)?.message ?? 'Something went wrong')
    }
  }

  useEffect(() => {
    if (user?.role === 'admin') load()
  }, [user?.role, status]) // eslint-disable-line react-hooks/exhaustive-deps

  if (user?.role !== 'admin') return <p className="text-gray-400">Admin access required.</p>

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      await load()
    } catch (e) {
      setError((e as Error)?.message ?? 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        crumbs={['System', { label: 'Admin', href: '/admin' }, 'Studio flags']}
        title="Studio flags"
        subtitle="Accounts whose studio messages keep getting turned down as work that isn't a wearable or emote, and mistake reports waiting for a decision."
      />
      {error && <p className="mb-4 text-sm text-red-400" role="alert">{error}</p>}

      <section aria-labelledby="flags-title">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 id="flags-title" className="text-lg font-semibold">Flagged accounts</h2>
          <div className="flex gap-1 text-sm">
            {(['open', 'closed'] as const).map((s) => (
              <button key={s} type="button" onClick={() => { setFlags(null); setStatus(s) }}
                className={`rounded-md px-3 py-1.5 ${status === s ? 'bg-gray-800 text-white' : 'text-gray-400 hover:text-white'}`}>
                {s === 'open' ? 'Open' : 'Closed'}
              </button>
            ))}
          </div>
        </div>
        {!flags ? <Skeleton rows={2} className="h-16" /> : flags.length === 0 ? (
          <p className="text-gray-400">{status === 'open' ? 'No account is flagged.' : 'No closed flags yet.'}</p>
        ) : (
          <ul className="space-y-3">
            {flags.map((f) => (
              <li key={f.id} className="rounded-lg border border-gray-800 bg-gray-900 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium">{f.user.email ?? f.user.id} <span className="text-sm text-gray-500">· {f.user.plan} plan</span></p>
                    <p className="text-sm text-gray-400">{flagSummary(f)}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {f.paused && <Badge tone="warning">Paused</Badge>}
                    {f.status === 'open' && (
                      <button type="button" disabled={busy} onClick={() => act(() => api.dismissAdminStudioFlag(f.id))}
                        className="rounded-md bg-gray-800 px-3 py-1.5 text-sm hover:bg-gray-700">Dismiss</button>
                    )}
                    {f.paused ? (
                      <button type="button" disabled={busy} onClick={() => act(() => api.resumeStudioUser(f.user.id))}
                        className="rounded-md bg-gray-800 px-3 py-1.5 text-sm hover:bg-gray-700">Resume studio access</button>
                    ) : (
                      <ConfirmAction prompt="Pause their studio access? They can still finalize and download." confirmLabel="Pause"
                        onConfirm={() => act(() => api.pauseStudioUser(f.user.id))} disabled={busy}
                        className="rounded-md bg-red-600/80 px-3 py-1.5 text-sm text-white hover:bg-red-600">
                        Pause studio access
                      </ConfirmAction>
                    )}
                  </div>
                </div>
                <ul className="mt-3 divide-y divide-gray-800 border-t border-gray-800 text-sm">
                  {f.events.map((e, i) => (
                    <li key={i} className="py-2">
                      <p className="text-xs text-gray-500">
                        {dateFmt.format(new Date(e.createdAt))} · {SCOPE_CATEGORY_WORDS[e.category] ?? e.category} · turned down by {e.by === 'check' ? 'the check' : 'the agent'}
                      </p>
                      <p className="whitespace-pre-wrap break-words text-gray-200">{e.message}</p>
                      {e.note && <p className="text-xs italic text-gray-400">{e.note}</p>}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="reports-title" className="mt-10">
        <h2 id="reports-title" className="mb-3 text-lg font-semibold">Mistake reports to review</h2>
        {!reports ? <Skeleton rows={1} className="h-16" /> : reports.length === 0 ? (
          <p className="text-gray-400">No report is waiting.</p>
        ) : (
          <ul className="space-y-3">
            {reports.map((r) => (
              <li key={r.id} className="rounded-lg border border-gray-800 bg-gray-900 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium">{r.piece.name}: revision {r.revisionNumber} <span className="text-sm text-gray-500">· {formatCents(r.refundCents)}</span></p>
                    <p className="text-sm text-gray-400">{r.user.email ?? r.user.id} · {dateFmt.format(new Date(r.createdAt))}</p>
                  </div>
                  <div className="flex gap-2">
                    <PrimaryButton type="button" disabled={busy} onClick={() => act(() => api.approveAdminStudioReport(r.id))}>
                      Approve and refund
                    </PrimaryButton>
                    <button type="button" disabled={busy} onClick={() => act(() => api.declineAdminStudioReport(r.id))}
                      className="rounded-md bg-gray-800 px-3 py-1.5 text-sm hover:bg-gray-700">Decline</button>
                  </div>
                </div>
                <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-xs text-gray-500">What the customer says went wrong</dt>
                    <dd className="whitespace-pre-wrap break-words text-gray-200">{r.text}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-gray-500">What the revision was asked to do</dt>
                    <dd className="whitespace-pre-wrap break-words text-gray-200">{r.request || '—'}</dd>
                  </div>
                </dl>
                {(r.before || r.after) && (
                  <div className="mt-3 flex flex-wrap gap-3">
                    {([['Before', r.before], ['After', r.after]] as const).map(([label, src]) => (
                      <figure key={label} className="w-40">
                        {src ? <img src={src} alt={`${label}: ${r.piece.name}`} className="aspect-square w-full rounded-md bg-gray-950 object-contain" />
                          : <div className="flex aspect-square w-full items-center justify-center rounded-md bg-gray-950 text-xs text-gray-500">No render</div>}
                        <figcaption className="mt-1 text-xs text-gray-500">{label}</figcaption>
                      </figure>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
