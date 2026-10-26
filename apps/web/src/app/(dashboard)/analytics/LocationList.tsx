import Link from 'next/link'
import type { AnalyticsLocation } from '@/lib/analytics/types'
import { dashboardHref } from '@/lib/analytics/view'
import { Badge, PageHeader } from '@/components/ui'
import { countLabel } from '@/lib/format'

const KIND_LABEL: Record<AnalyticsLocation['kind'], string> = { parcels: 'Genesis City', world: 'World', preview: 'Preview', hyperfy: 'Hyperfy', ar: 'AR' }

export const formatDay = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })

/** "Data from <since> to <until>" for an ended tenure; null while the tenure is current. */
export function tenureLabel(l: Pick<AnalyticsLocation, 'since' | 'until'>): string | null {
  if (!l.until) return null
  return l.since ? `Data from ${formatDay(l.since)} to ${formatDay(l.until)}` : `Data to ${formatDay(l.until)}`
}

export function LocationList({ locations, note }: { locations: AnalyticsLocation[]; note?: string }) {
  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader crumbs={['Tools', 'Analytics']} title="Analytics" count={countLabel(locations.length)} subtitle="See who visits your scenes and when." />
      {note && (
        <p className="mb-4 rounded-lg border border-gray-800 bg-gray-900 px-4 py-3 text-sm text-gray-300" role="status">{note}</p>
      )}
      {locations.length === 0 ? (
        <div className="rounded-lg border border-gray-800 bg-gray-900 p-6 text-sm text-gray-400">
          No analytics yet. Analytics start as soon as a scene with <code className="rounded bg-gray-800 px-1 py-0.5 text-gray-200">virvi-dcl</code> gets
          visitors; set the scene up in-world from the Virvi HUD to see them here.
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {locations.map((l) => {
            const tenure = tenureLabel(l)
            return (
              <li key={l.id} className="min-w-0">
                <Link
                  href={dashboardHref(l.id)}
                  className="block h-full rounded-lg border border-gray-800 bg-gray-900 p-4 transition-colors hover:border-gray-700 focus-visible:border-blue-400 focus-visible:outline-none"
                >
                  <div className="flex items-start justify-between gap-3">
                    <h2 className="min-w-0 truncate font-semibold text-white">{l.title || l.locationKey}</h2>
                    <Badge>{KIND_LABEL[l.kind] ?? l.kind}</Badge>
                  </div>
                  <p className="mt-1 truncate text-sm text-gray-400">{l.locationKey}</p>
                  {tenure && <p className="mt-2 text-xs text-gray-500">{tenure}</p>}
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
