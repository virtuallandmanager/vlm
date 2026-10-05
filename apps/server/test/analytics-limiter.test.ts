import { describe, it, expect } from 'vitest'
import { TokenBucketLimiter, checkIngestLimits, checkIpLimits, checkRequesterLimits } from '../src/analytics/limiter.js'
import { createCountryLookup } from '../src/analytics/country.js'

function limiter() {
  let now = 0
  const l = new TokenBucketLimiter(() => now)
  return { l, advance: (ms: number) => (now += ms) }
}

const input = (o: Partial<Parameters<typeof checkIngestLimits>[1]> = {}) => ({
  requesterKey: 'w:0xabc',
  verified: true,
  sceneId: 's1',
  isPreview: false,
  eventCount: 10,
  posCount: 5,
  dayKey: '2026-10-04',
  ...o,
})

describe('ingest limits', () => {
  it('allows a burst of 3 requests then one per 2 s', () => {
    const { l, advance } = limiter()
    for (let i = 0; i < 3; i++) expect(checkIngestLimits(l, input()).ok).toBe(true)
    const r = checkIngestLimits(l, input())
    expect(r.ok).toBe(false)
    expect(!r.ok && r.retryAfterMs).toBeGreaterThan(0)
    advance(2_000)
    expect(checkIngestLimits(l, input()).ok).toBe(true)
  })

  it('checkRequesterLimits alone rejects the 4th request in a burst', () => {
    const { l } = limiter()
    const req = { requesterKey: 'w:0xabc', verified: true, eventCount: 10 }
    for (let i = 0; i < 3; i++) expect(checkRequesterLimits(l, req).ok).toBe(true)
    const r = checkRequesterLimits(l, req)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.retryAfterMs).toBeGreaterThan(0)
  })

  it('caps a verified signer at 200 events per minute', () => {
    const { l, advance } = limiter()
    expect(checkIngestLimits(l, input({ eventCount: 100 })).ok).toBe(true)
    advance(2_000)
    expect(checkIngestLimits(l, input({ eventCount: 100 })).ok).toBe(true)
    advance(2_000)
    expect(checkIngestLimits(l, input({ eventCount: 100 })).ok).toBe(false)
  })

  it('caps an unverified IP at a 100-event burst (60 per minute sustained)', () => {
    const { l } = limiter()
    expect(checkIngestLimits(l, input({ verified: false, requesterKey: 'ip:1.2.3.4', eventCount: 100 })).ok).toBe(true)
    expect(checkIngestLimits(l, input({ verified: false, requesterKey: 'ip:1.2.3.4', eventCount: 1 })).ok).toBe(false)
  })

  it('accepts one max-size unverified batch, then rejects an immediate second with a retry hint', () => {
    const { l } = limiter()
    const u = { verified: false, requesterKey: 'ip:9.9.9.9', eventCount: 100 }
    expect(checkIngestLimits(l, input(u)).ok).toBe(true)
    const r = checkIngestLimits(l, input(u))
    expect(r.ok).toBe(false)
    expect(!r.ok && r.retryAfterMs).toBeGreaterThan(0)
  })

  it('never offers a retry for a cost above bucket capacity', () => {
    const { l } = limiter()
    const t = l.take('k', 201, 200, 1)
    expect(t.ok).toBe(false)
    expect(t.retryAfterMs).toBe(0)
    const r = checkRequesterLimits(l, { requesterKey: 'w:big', verified: true, eventCount: 201 })
    expect(r).toEqual({ ok: false, retryAfterMs: 0, tooLarge: true })
  })

  it('samples positions once a scene passes 5,000 events per minute, never other events', () => {
    const { l } = limiter()
    for (let i = 0; i < 50; i++) checkIngestLimits(l, input({ requesterKey: `w:${i}`, eventCount: 100, posCount: 90 }))
    const r = checkIngestLimits(l, input({ requesterKey: 'w:new', eventCount: 100, posCount: 90 }))
    expect(r.ok).toBe(true)
    expect(r.ok && r.keepPosProbability).toBeLessThan(1)
    expect(r.ok && r.keepPosProbability).toBeGreaterThan(0)
  })

  it('caps preview scenes at 10,000 events per day', () => {
    const { l, advance } = limiter()
    let accepted = 0
    for (let i = 0; i < 120; i++) {
      advance(2_000)
      const r = checkIngestLimits(l, input({ requesterKey: `w:${i}`, isPreview: true, eventCount: 100, posCount: 0 }))
      if (r.ok) accepted += 100
    }
    expect(accepted).toBe(10_000)
  })
})

describe('per-IP ingest limits (all traffic, verified or not)', () => {
  it('allows a 10-request burst per IP, then 2 per second', () => {
    const { l, advance } = limiter()
    for (let i = 0; i < 10; i++) expect(checkIpLimits(l, { ip: '1.2.3.4', eventCount: 1 }).ok).toBe(true)
    const r = checkIpLimits(l, { ip: '1.2.3.4', eventCount: 1 })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.retryAfterMs).toBeGreaterThan(0)
    expect(checkIpLimits(l, { ip: '5.6.7.8', eventCount: 1 }).ok).toBe(true)
    advance(500)
    expect(checkIpLimits(l, { ip: '1.2.3.4', eventCount: 1 }).ok).toBe(true)
  })

  it('allows a 600-event burst per IP, then 10 events per second', () => {
    const { l, advance } = limiter()
    for (let i = 0; i < 6; i++) {
      expect(checkIpLimits(l, { ip: '1.2.3.4', eventCount: 100 }).ok).toBe(true)
      advance(500) // keep the request bucket topped up; adds 5 events each time
    }
    const r = checkIpLimits(l, { ip: '1.2.3.4', eventCount: 100 })
    expect(r.ok).toBe(false)
    advance(10_000)
    expect(checkIpLimits(l, { ip: '1.2.3.4', eventCount: 100 }).ok).toBe(true)
  })
})

describe('country lookup', () => {
  it('uses the cf-ipcountry header and ignores unknown codes', async () => {
    const c = await createCountryLookup(undefined)
    expect(c.lookup('1.2.3.4', { 'cf-ipcountry': 'de' })).toBe('DE')
    expect(c.lookup('1.2.3.4', { 'cf-ipcountry': 'XX' })).toBeNull()
    expect(c.lookup('1.2.3.4', {})).toBeNull()
  })
})
