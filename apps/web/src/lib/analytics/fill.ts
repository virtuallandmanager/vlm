import type { TimeseriesPoint } from './types'

const STEP = { hour: 3_600_000, day: 86_400_000 } as const

/** The API omits empty buckets; emit every bucket from `from` (truncated to the UTC hour/day) to `to`, zero-filling gaps. */
export function fillBuckets(points: TimeseriesPoint[], from: string, to: string, bucket: 'hour' | 'day'): TimeseriesPoint[] {
  const step = STEP[bucket]
  const start = Date.parse(from)
  const end = Date.parse(to)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return points
  const byMs = new Map(points.map((p) => [Date.parse(p.t), p]))
  const out: TimeseriesPoint[] = []
  // UTC hours and days are whole multiples of the step from the epoch.
  for (let ms = Math.floor(start / step) * step; ms <= end; ms += step) {
    out.push(byMs.get(ms) ?? { t: new Date(ms).toISOString(), sessions: 0, uniqueVisitors: 0, peakConcurrency: 0, dwellAvgSec: 0 })
  }
  return out
}
