import { describe, it, expect } from 'vitest'
import { fillBuckets } from './fill'

describe('fillBuckets', () => {
  it('adds zero points for missing hourly buckets', () => {
    const pts = [
      { t: '2026-10-16T00:00:00.000Z', sessions: 1, uniqueVisitors: 1, peakConcurrency: 1, dwellAvgSec: 10 },
      { t: '2026-10-16T03:00:00.000Z', sessions: 2, uniqueVisitors: 2, peakConcurrency: 1, dwellAvgSec: 10 },
      { t: '2026-10-16T04:00:00.000Z', sessions: 1, uniqueVisitors: 1, peakConcurrency: 1, dwellAvgSec: 10 },
    ]
    const out = fillBuckets(pts, '2026-10-16T00:00:00.000Z', '2026-10-16T04:30:00.000Z', 'hour')
    expect(out.map((p) => p.sessions)).toEqual([1, 0, 0, 2, 1])
  })
  it('day buckets step in UTC days', () => {
    const out = fillBuckets([], '2026-10-14T10:00:00.000Z', '2026-10-16T10:00:00.000Z', 'day')
    expect(out.map((p) => p.t)).toEqual(['2026-10-14T00:00:00.000Z', '2026-10-15T00:00:00.000Z', '2026-10-16T00:00:00.000Z'])
  })
})
