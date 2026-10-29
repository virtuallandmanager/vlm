'use client'
import { useEffect, useState } from 'react'
import { useApi } from '@/lib/api'
import { PrimaryButton } from '@/components/ui'
import {
  checkoutBody, dialogTotal, finalizeStrip, formatCents, REPORT_MAX, refusalMessage, reportOk,
  type Quote, type QuoteLine, type Refusal, type StudioKind,
} from '@/lib/studio'

const PRICE_LABEL: Record<QuoteLine['priceKind'], string> = {
  first: 'First finalize',
  first_extra: 'Extra piece',
  revision: 'Revision',
  revision_extra: 'Revision',
}

type Props = { designId: string; kind: StudioKind; quote: Quote | null; busy: boolean; onChanged: () => Promise<void> }

/** The finalize strip under the preview, and the dialog that pays for every payable piece at once. */
export default function Finalize({ designId, kind, quote, busy, onChanged }: Props) {
  const [open, setOpen] = useState(false)
  const strip = finalizeStrip(quote, kind)
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
      <p className="text-sm text-gray-300">{strip.unlocks}</p>
      {strip.blocked && <p className="mt-2 text-sm text-amber-300">{strip.blocked}</p>}
      {strip.button && (
        <PrimaryButton type="button" className="mt-3" disabled={busy} onClick={() => setOpen(true)}>{strip.button}</PrimaryButton>
      )}
      {open && quote && <FinalizeDialog designId={designId} quote={quote} onClose={() => setOpen(false)} onChanged={onChanged} />}
    </div>
  )
}

function FinalizeDialog({ designId, quote, onClose, onChanged }: { designId: string; quote: Quote; onClose: () => void; onChanged: () => Promise<void> }) {
  const api = useApi()
  const [reports, setReports] = useState<Record<string, string>>({})
  const [paying, setPaying] = useState(false)
  const [refusal, setRefusal] = useState<Refusal | null>(null)

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !paying) onClose() }
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
  }, [onClose, paying])

  const reported = Object.keys(reports)
  const incomplete = reported.some((c) => !reportOk(reports[c]))
  const total = dialogTotal(quote, reported)

  const toggle = (category: string) => setReports((prev) => {
    const next = { ...prev }
    if (category in next) delete next[category]
    else next[category] = ''
    return next
  })

  const pay = async () => {
    setPaying(true)
    setRefusal(null)
    try {
      const r = await api.finalizeStudio(designId, checkoutBody(reports))
      if ('url' in r) {
        window.location.assign(r.url)
        return
      }
      onClose()
      await onChanged()
    } catch (err) {
      setRefusal(refusalMessage(err as never, new Date()))
      setPaying(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget && !paying) onClose() }}>
      <div role="dialog" aria-modal="true" aria-labelledby="finalize-title" className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg border border-gray-800 bg-gray-900 p-5">
        <h2 id="finalize-title" className="text-lg font-semibold">Finalize</h2>
        <ul className="mt-4 divide-y divide-gray-800">
          {quote.lines.map((l) => {
            const waived = l.category in reports
            const revision = l.priceKind.startsWith('revision')
            return (
              <li key={l.category} className="py-3">
                <div className="flex items-baseline justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{l.pieceName}</p>
                    <p className="text-xs text-gray-500">{PRICE_LABEL[l.priceKind]} · revision {l.revisionNumber}</p>
                  </div>
                  <p className="shrink-0 text-right">
                    <span className={waived ? 'text-gray-500 line-through' : ''}>{formatCents(l.amountCents)}</span>
                    {waived && <span className="block text-xs text-emerald-300">not charged</span>}
                  </p>
                </div>
                {revision && (
                  <label className="mt-2 flex items-center gap-2 text-sm text-gray-300">
                    <input type="checkbox" checked={waived} onChange={() => toggle(l.category)} />
                    This revision fixes the agent’s mistake
                  </label>
                )}
                {waived && (
                  <label className="mt-2 block">
                    <span className="mb-1 block text-xs text-gray-400">What did the agent get wrong?</span>
                    <textarea rows={3} maxLength={REPORT_MAX} value={reports[l.category]}
                      onChange={(e) => setReports((prev) => ({ ...prev, [l.category]: e.target.value }))}
                      className="w-full rounded-md border border-gray-800 bg-gray-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-400" />
                    {!reportOk(reports[l.category]) && <span className="text-xs text-gray-500">At least 10 characters.</span>}
                  </label>
                )}
              </li>
            )
          })}
        </ul>
        {quote.notes.map((n) => <p key={n} className="mt-3 text-sm text-gray-400">{n}</p>)}
        <div className="mt-4 flex items-baseline justify-between border-t border-gray-800 pt-4">
          <span className="text-gray-400">Total</span>
          <span className="text-xl font-semibold">{formatCents(total)}</span>
        </div>
        {refusal && <p className="mt-3 text-sm text-amber-300" role="alert">{refusal.text}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={paying} className="rounded-md bg-gray-800 px-4 py-2 text-sm hover:bg-gray-700">Cancel</button>
          <PrimaryButton type="button" onClick={pay} disabled={paying || incomplete}>
            {paying ? 'Opening Stripe…' : total > 0 ? `Pay ${formatCents(total)}` : 'Finalize'}
          </PrimaryButton>
        </div>
      </div>
    </div>
  )
}
