export type RangeKey = '24h' | '7d' | '30d' | 'custom'
export type RangeQuery = { from: string; to: string; bucket: 'hour' | 'day' }

const DAY = 86_400_000
const MAX_DAYS = 400
const PRESET: Record<Exclude<RangeKey, 'custom'>, { days: number; bucket: 'hour' | 'day' }> = {
  '24h': { days: 1, bucket: 'hour' },
  '7d': { days: 7, bucket: 'hour' },
  '30d': { days: 30, bucket: 'day' },
}

function localDay(s: string, end: boolean): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return null
  const d = end ? new Date(+m[1], +m[2] - 1, +m[3], 23, 59, 59, 999) : new Date(+m[1], +m[2] - 1, +m[3], 0, 0, 0, 0)
  return Number.isNaN(d.getTime()) ? null : d
}

export function rangeQuery(key: RangeKey, now: Date, custom?: { from: string; to: string }): RangeQuery | { error: string } {
  if (key !== 'custom') {
    const p = PRESET[key]
    return { from: new Date(now.getTime() - p.days * DAY).toISOString(), to: now.toISOString(), bucket: p.bucket }
  }
  const from = custom && localDay(custom.from, false)
  const to = custom && localDay(custom.to, true)
  if (!from || !to) return { error: 'Pick a start and end date' }
  if (from > to) return { error: 'The start date must be before the end date' }
  if (to.getTime() - from.getTime() > MAX_DAYS * DAY) return { error: 'Pick a range of at most 400 days' }
  return { from: from.toISOString(), to: to.toISOString(), bucket: to.getTime() - from.getTime() > 7 * DAY ? 'day' : 'hour' }
}
