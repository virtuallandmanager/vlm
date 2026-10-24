'use client'
import { useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react'
import type { TimeseriesPoint } from '@/lib/analytics/types'
import { fillBuckets } from '@/lib/analytics/fill'
import { linearScale, niceTicks } from '@/lib/analytics/scale'
import { compact, full } from './format'

type Series = 'uniqueVisitors' | 'sessions' | 'peakConcurrency'
type Bucket = 'hour' | 'day'

const SERIES_LABEL: Record<Series, string> = {
  uniqueVisitors: 'Unique visitors',
  sessions: 'Sessions',
  peakConcurrency: 'Peak concurrency',
}
const W = 560
const H = 200
const M = { top: 12, right: 12, bottom: 28, left: 40 }

function bucketLabel(t: string, bucket: Bucket, long: boolean) {
  const d = new Date(t)
  if (bucket === 'day') return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC', ...(long && { year: 'numeric' }) })
  return long
    ? d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' })
}

/**
 * Area + line over time. The API omits empty buckets, so gaps are zero-filled before drawing:
 * from `from` to `to` when given, otherwise between the first and last point.
 */
export function TimeSeriesChart({ points, series, bucket, from, to }: {
  points: TimeseriesPoint[]; series: Series; bucket: Bucket; from?: string; to?: string
}) {
  const [hover, setHover] = useState<number | null>(null)
  const data = useMemo(() => {
    const start = from ?? points[0]?.t
    const end = to ?? points[points.length - 1]?.t
    return start && end ? fillBuckets(points, start, end, bucket) : points
  }, [points, from, to, bucket])

  const values = data.map((p) => p[series])
  const ticks = niceTicks(Math.max(0, ...values))
  const yMax = ticks[ticks.length - 1]
  const y = linearScale([0, yMax], [H - M.bottom, M.top])
  const x = data.length > 1 ? linearScale([0, data.length - 1], [M.left, W - M.right]) : () => (M.left + W - M.right) / 2
  const base = H - M.bottom

  const line = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('')
  const area = data.length ? `${line}L${x(data.length - 1).toFixed(1)},${base}L${x(0).toFixed(1)},${base}Z` : ''
  // Hour labels carry the date too, so they get fewer slots than day labels.
  const labelStep = Math.max(1, Math.ceil(data.length / (bucket === 'hour' ? 5 : 6)))
  const xLabels = data.map((_, i) => i).filter((i) => i % labelStep === 0)
  const label = SERIES_LABEL[series]

  const pick = (e: PointerEvent<SVGSVGElement>) => {
    if (!data.length) return
    const r = e.currentTarget.getBoundingClientRect()
    const vx = ((e.clientX - r.left) / r.width) * W
    const i = data.length > 1 ? Math.round(((vx - M.left) / (W - M.left - M.right)) * (data.length - 1)) : 0
    setHover(Math.min(data.length - 1, Math.max(0, i)))
  }
  const key = (e: KeyboardEvent<SVGSVGElement>) => {
    if (!data.length) return
    const cur = hover ?? data.length - 1
    const next = e.key === 'ArrowLeft' ? cur - 1 : e.key === 'ArrowRight' ? cur + 1 : e.key === 'Home' ? 0 : e.key === 'End' ? data.length - 1 : null
    if (next === null) return
    e.preventDefault()
    setHover(Math.min(data.length - 1, Math.max(0, next)))
  }

  const h = hover !== null ? data[hover] : null
  const peak = Math.max(0, ...values)

  return (
    <figure className="relative m-0">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        role="img"
        aria-label={`${label} per ${bucket}${bucket === 'day' ? ' (UTC days)' : ''}, ${data.length} buckets, peak ${full(peak)}. Use arrow keys to read values.`}
        tabIndex={0}
        className="block touch-pan-y select-none outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded"
        onPointerMove={pick}
        onPointerDown={pick}
        onPointerLeave={() => setHover(null)}
        onPointerCancel={() => setHover(null)}
        onFocus={() => setHover((v) => v ?? (data.length ? data.length - 1 : null))}
        onBlur={() => setHover(null)}
        onKeyDown={key}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={M.left} x2={W - M.right} y1={y(t)} y2={y(t)} style={{ stroke: t === 0 ? 'var(--chart-axis)' : 'var(--chart-grid)' }} strokeWidth={1} shapeRendering="crispEdges" />
            <text x={M.left - 6} y={y(t)} dy="0.32em" textAnchor="end" fontSize={11} style={{ fill: 'var(--chart-text-muted)', fontVariantNumeric: 'tabular-nums' }}>
              {compact(t)}
            </text>
          </g>
        ))}
        {xLabels.map((i) => (
          <text key={i} x={x(i)} y={H - 8} textAnchor={data.length > 1 && i === data.length - 1 ? 'end' : 'middle'} fontSize={11} style={{ fill: 'var(--chart-text-muted)' }}>
            {bucketLabel(data[i].t, bucket, false)}
          </text>
        ))}
        {area && <path d={area} stroke="none" style={{ fill: 'var(--chart-1)', fillOpacity: 'var(--chart-area-opacity)' }} />}
        {data.length > 1 && <path d={line} fill="none" style={{ stroke: 'var(--chart-1)' }} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
        {h && hover !== null && (
          <g pointerEvents="none">
            <line x1={x(hover)} x2={x(hover)} y1={M.top} y2={base} style={{ stroke: 'var(--chart-crosshair)' }} strokeWidth={1} shapeRendering="crispEdges" />
            <circle cx={x(hover)} cy={y(h[series])} r={4} style={{ fill: 'var(--chart-1)', stroke: 'var(--chart-surface)' }} strokeWidth={2} />
          </g>
        )}
        {data.length === 1 && <circle cx={x(0)} cy={y(values[0])} r={4} style={{ fill: 'var(--chart-1)', stroke: 'var(--chart-surface)' }} strokeWidth={2} />}
      </svg>
      {bucket === 'day' && <figcaption className="mt-1 text-right text-xs text-gray-500">(UTC days)</figcaption>}
      {h && hover !== null && (
        <div
          role="status"
          className="pointer-events-none absolute top-0 z-10 rounded-md bg-gray-800 px-3 py-2 text-xs shadow-lg ring-1 ring-white/10 whitespace-nowrap"
          style={{
            left: `${(x(hover) / W) * 100}%`,
            transform: x(hover) > W / 2 ? 'translateX(calc(-100% - 8px))' : 'translateX(8px)',
          }}
        >
          <p className="text-sm font-semibold text-white">{full(h[series])}</p>
          <p className="flex items-center gap-1.5 text-gray-400">
            <span aria-hidden="true" className="inline-block h-0.5 w-3 rounded" style={{ background: 'var(--chart-1)' }} />
            {label}
          </p>
          <p className="text-gray-400">{bucketLabel(h.t, bucket, true)}{bucket === 'day' ? ' (UTC)' : ''}</p>
        </div>
      )}
      <table className="sr-only">
        <caption>{label}</caption>
        <thead><tr><th scope="col">{bucket === 'day' ? 'Day (UTC)' : 'Hour'}</th><th scope="col">{label}</th></tr></thead>
        <tbody>
          {data.map((p) => (
            <tr key={p.t}><td>{bucketLabel(p.t, bucket, true)}</td><td>{full(p[series])}</td></tr>
          ))}
        </tbody>
      </table>
    </figure>
  )
}
