import { describe, it, expect } from 'vitest'
import { HYPERFY_FEED, checkHyperfyAnalyticsBatch } from 'vlm-shared'

const pos = { type: 'pos', playerId: 'p1', t: 1000, x: 1, y: 2, z: 3 }

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
    const r = checkHyperfyAnalyticsBatch(body)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.batch.events).toHaveLength(3)
  })

  it('accepts an empty events array', () => {
    expect(checkHyperfyAnalyticsBatch({ v: 1, events: [] }).ok).toBe(true)
  })

  it('rejects pos without coordinates', () => {
    expect(checkHyperfyAnalyticsBatch({ v: 1, events: [{ type: 'pos', playerId: 'p1', t: 1, x: 1, y: 2 }] }).ok).toBe(false)
  })

  it('rejects coordinates on enter', () => {
    expect(checkHyperfyAnalyticsBatch({ v: 1, events: [{ type: 'enter', playerId: 'p1', t: 1, x: 1, y: 2, z: 3 }] }).ok).toBe(false)
  })

  it('rejects more than 200 events', () => {
    const events = Array.from({ length: 201 }, () => ({ type: 'enter', playerId: 'p1', t: 1 }))
    expect(checkHyperfyAnalyticsBatch({ v: 1, events }).ok).toBe(false)
    expect(checkHyperfyAnalyticsBatch({ v: 1, events: events.slice(0, 200) }).ok).toBe(true)
  })

  it('rejects an unknown type', () => {
    expect(checkHyperfyAnalyticsBatch({ v: 1, events: [{ type: 'jump', playerId: 'p1', t: 1 }] }).ok).toBe(false)
  })

  it('rejects bad envelopes, long or empty playerIds and non-finite numbers', () => {
    expect(checkHyperfyAnalyticsBatch(null).ok).toBe(false)
    expect(checkHyperfyAnalyticsBatch({ v: 2, events: [] }).ok).toBe(false)
    expect(checkHyperfyAnalyticsBatch({ v: 1 }).ok).toBe(false)
    expect(checkHyperfyAnalyticsBatch({ v: 1, events: [{ type: 'enter', playerId: 'x'.repeat(101), t: 1 }] }).ok).toBe(false)
    expect(checkHyperfyAnalyticsBatch({ v: 1, events: [{ type: 'enter', playerId: '', t: 1 }] }).ok).toBe(false)
    expect(checkHyperfyAnalyticsBatch({ v: 1, events: [{ type: 'enter', playerId: 'p', t: NaN }] }).ok).toBe(false)
    expect(checkHyperfyAnalyticsBatch({ v: 1, events: [{ ...pos, x: Infinity }] }).ok).toBe(false)
    expect(checkHyperfyAnalyticsBatch({ v: 1, events: ['nope'] }).ok).toBe(false)
  })
})
