import { describe, it, expect } from 'vitest'
import { HYPERFY_ANALYTICS_LIMITS, HYPERFY_FEED, checkHyperfyAnalyticsBatch } from '@virvixr/shared'

const pos = { type: 'pos', playerId: 'p1', t: 1000, x: 1, y: 2, z: 3 }
/** Every fixture's t is within the last 24 h of this. */
const NOW = 3000

describe('HYPERFY_FEED values', () => {
  it('holds the fixed protocol values', () => {
    expect(HYPERFY_FEED).toEqual({
      version: 1,
      holdMs: 25_000,
      retryMinMs: 1_000,
      retryMaxMs: 30_000,
      lastSeenThrottleMs: 60_000,
      analyticsFlushMs: 15_000,
      positionSampleMs: 5_000,
      keyPrefix: 'vlmw_',
    })
  })
})

describe('checkHyperfyAnalyticsBatch', () => {
  it('accepts enter/leave/pos', () => {
    const body = { v: 1, events: [{ type: 'enter', playerId: 'p1', t: 1 }, pos, { type: 'leave', playerId: 'p1', t: 2000 }] }
    const r = checkHyperfyAnalyticsBatch(body, NOW)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.batch.events).toHaveLength(3)
  })

  it('accepts an empty events array', () => {
    expect(checkHyperfyAnalyticsBatch({ v: 1, events: [] }, NOW).ok).toBe(true)
  })

  it('rejects pos without coordinates', () => {
    expect(checkHyperfyAnalyticsBatch({ v: 1, events: [{ type: 'pos', playerId: 'p1', t: 1, x: 1, y: 2 }] }, NOW).ok).toBe(false)
  })

  it('rejects coordinates on enter', () => {
    expect(checkHyperfyAnalyticsBatch({ v: 1, events: [{ type: 'enter', playerId: 'p1', t: 1, x: 1, y: 2, z: 3 }] }, NOW).ok).toBe(false)
  })

  it('rejects more than 200 events', () => {
    const events = Array.from({ length: 201 }, () => ({ type: 'enter', playerId: 'p1', t: 1 }))
    expect(checkHyperfyAnalyticsBatch({ v: 1, events }, NOW).ok).toBe(false)
    expect(checkHyperfyAnalyticsBatch({ v: 1, events: events.slice(0, 200) }, NOW).ok).toBe(true)
  })

  it('rejects an unknown type', () => {
    expect(checkHyperfyAnalyticsBatch({ v: 1, events: [{ type: 'jump', playerId: 'p1', t: 1 }] }, NOW).ok).toBe(false)
  })

  it('rejects bad envelopes, long or empty playerIds and non-finite numbers', () => {
    expect(checkHyperfyAnalyticsBatch(null, NOW).ok).toBe(false)
    expect(checkHyperfyAnalyticsBatch({ v: 2, events: [] }, NOW).ok).toBe(false)
    expect(checkHyperfyAnalyticsBatch({ v: 1 }, NOW).ok).toBe(false)
    expect(checkHyperfyAnalyticsBatch({ v: 1, events: [{ type: 'enter', playerId: 'x'.repeat(101), t: 1 }] }, NOW).ok).toBe(false)
    expect(checkHyperfyAnalyticsBatch({ v: 1, events: [{ type: 'enter', playerId: '', t: 1 }] }, NOW).ok).toBe(false)
    expect(checkHyperfyAnalyticsBatch({ v: 1, events: [{ type: 'enter', playerId: 'p', t: NaN }] }, NOW).ok).toBe(false)
    expect(checkHyperfyAnalyticsBatch({ v: 1, events: [{ ...pos, x: Infinity }] }, NOW).ok).toBe(false)
    expect(checkHyperfyAnalyticsBatch({ v: 1, events: ['nope'] }, NOW).ok).toBe(false)
  })

  it('rejects event times older than 24 h or more than 60 s ahead', () => {
    const now = Date.UTC(2026, 9, 20)
    const at = (t: number) => checkHyperfyAnalyticsBatch({ v: 1, events: [{ type: 'enter', playerId: 'p', t }] }, now)
    const { maxPastMs, maxFutureMs } = HYPERFY_ANALYTICS_LIMITS
    expect(maxPastMs).toBe(24 * 3600_000)
    expect(maxFutureMs).toBe(60_000)
    expect(at(now).ok).toBe(true)
    expect(at(now - maxPastMs).ok).toBe(true)
    expect(at(now + maxFutureMs).ok).toBe(true)
    for (const t of [now - maxPastMs - 1, now + maxFutureMs + 1, 0, 1e15]) {
      const r = at(t)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toMatch(/event\.t/)
    }
  })
})
