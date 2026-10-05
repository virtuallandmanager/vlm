import { describe, it, expect } from 'vitest'
import { checkBatch, locationKeyFor, isHighPriority, ANALYTICS_LIMITS, type IngestBatch } from 'vlm-shared'

const NOW = Date.parse('2026-10-04T12:00:00Z')
const SID = '11111111-1111-4111-8111-111111111111'

function batch(overrides: Partial<IngestBatch> = {}): any {
  return {
    v: 1,
    sessionId: SID,
    visitorId: '0xABCDEF0000000000000000000000000000000001',
    isGuest: false,
    noticeShown: false,
    scene: { realm: 'main', isWorld: false, isPreview: false, baseParcel: '-12,34', parcels: ['-12,34', '-12,35'] },
    events: [{ t: NOW, type: 'session.start', seq: 0, data: { platform: 'desktop' } }],
    ...overrides,
  }
}

describe('checkBatch string and depth hardening', () => {
  const deep = (leaf: unknown, n: number) => Array.from({ length: n }).reduce<unknown>((acc) => ({ k: acc }), leaf)
  const ev = (data: unknown) => batch({ events: [{ t: NOW, type: 'custom', seq: 0, data }] })
  it('rejects a NUL nested 25 levels deep', () => {
    expect(checkBatch(ev(deep('a\u0000b', 25)), NOW).ok).toBe(false)
  })
  it('rejects over-deep nesting', () => {
    expect(checkBatch(ev(deep('x', 25)), NOW)).toEqual({ ok: false, error: 'event data too deeply nested' })
  })
  it('rejects lone surrogates in values and keys', () => {
    expect(checkBatch(ev({ name: '\ud800' }), NOW).ok).toBe(false)
    expect(checkBatch(ev({ '\udc00x': 1 }), NOW).ok).toBe(false)
    expect(checkBatch(ev({ name: 'a\ud800b' }), NOW).ok).toBe(false)
  })
  it('accepts valid surrogate pairs (emoji)', () => {
    expect(checkBatch(ev({ name: 'hi \u{1F600}' }), NOW).ok).toBe(true)
  })
})

describe('checkBatch', () => {
  it.each([
    ['top-level string', batch({ displayName: 'a\u0000b' })],
    ['scene string', batch({ scene: { realm: 'ma\u0000in', isWorld: false, isPreview: false, baseParcel: '1,1' } })],
    ['nested event data', batch({ events: [{ t: NOW, type: 'custom', seq: 0, data: { name: 'x', props: { l: ['ok', 'a\u0000b'] } } }] })],
  ])('rejects NUL characters in %s', (_n, b) => {
    const r = checkBatch(b, NOW)
    expect(r).toEqual({ ok: false, error: 'strings must not contain NUL characters' })
  })

  it('accepts a valid batch and lowercases wallet visitor ids', () => {
    const r = checkBatch(batch(), NOW)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.batch.visitorId).toBe('0xabcdef0000000000000000000000000000000001')
      expect(r.skewed).toBe(0)
    }
  })

  it.each([
    ['not an object', 'x'],
    ['wrong version', batch({ v: 2 as any })],
    ['bad session id', batch({ sessionId: 'nope' })],
    ['empty events', batch({ events: [] })],
    ['too many events', batch({ events: Array.from({ length: 101 }, (_, i) => ({ t: NOW, type: 'pos', seq: i })) })],
    ['unknown type', batch({ events: [{ t: NOW, type: 'mouse', seq: 0 } as any] })],
    ['negative seq', batch({ events: [{ t: NOW, type: 'pos', seq: -1 }] })],
    ['bad parcel', batch({ scene: { realm: 'main', isWorld: false, isPreview: false, baseParcel: '1;2' } })],
    ['world without name', batch({ scene: { realm: 'x.dcl.eth', isWorld: true, isPreview: false } })],
    ['oversized event', batch({ events: [{ t: NOW, type: 'custom', seq: 0, data: { name: 'x', props: { s: 'a'.repeat(3000) } } }] })],
  ])('rejects %s', (_label, input) => {
    expect(checkBatch(input, NOW).ok).toBe(false)
  })

  it('measures the 2 KB limit in UTF-8 bytes, not UTF-16 units', () => {
    const r = checkBatch(batch({ events: [{ t: NOW, type: 'custom', seq: 0, data: { name: '漢'.repeat(1000) } }] }), NOW)
    expect(r.ok).toBe(false)
  })

  it('returns ok:false for unserializable events instead of throwing', () => {
    const data: any = { n: 10n } // JSON.stringify throws on BigInt
    const r = checkBatch(batch({ events: [{ t: NOW, type: 'custom', seq: 0, data }] }), NOW)
    expect(r).toEqual({ ok: false, error: 'event is not serializable' })
  })

  it('rejects cyclic event data without throwing', () => {
    const data: any = {}
    data.self = data
    expect(checkBatch(batch({ events: [{ t: NOW, type: 'custom', seq: 0, data }] }), NOW).ok).toBe(false)
  })

  it('bounds seq to int4', () => {
    expect(checkBatch(batch({ events: [{ t: NOW, type: 'pos', seq: 2147483648 }] }), NOW).ok).toBe(false)
    expect(checkBatch(batch({ events: [{ t: NOW, type: 'pos', seq: 2147483647 }] }), NOW).ok).toBe(true)
  })

  it('clamps events whose clock is more than 10 minutes off', () => {
    const r = checkBatch(batch({ events: [{ t: NOW - 11 * 60_000, type: 'pos', seq: 0, data: { x: 1, y: 0, z: 1 } }] }), NOW)
    expect(r.ok && r.batch.events[0].t).toBe(NOW)
    expect(r.ok && r.skewed).toBe(1)
  })
})

describe('locationKeyFor', () => {
  it('builds keys for parcels, worlds and preview', () => {
    expect(locationKeyFor({ realm: 'main', isWorld: false, isPreview: false, baseParcel: '-12,34' }, null)).toBe('gc:-12,34')
    expect(locationKeyFor({ realm: 'Foo.dcl.eth', isWorld: true, isPreview: false, worldName: 'Foo.dcl.eth' }, null)).toBe('world:foo.dcl.eth')
    expect(locationKeyFor({ realm: 'localhost', isWorld: false, isPreview: true, baseParcel: '0,0' }, '0xabc')).toBe('preview:0xabc:0,0')
    expect(locationKeyFor({ realm: 'localhost', isWorld: false, isPreview: true, baseParcel: '0,0' }, null)).toBe('preview:anon:0,0')
  })
})

describe('isHighPriority', () => {
  it('flags starts, leaves, clicks, video, emotes, giveaways, custom — not hovers, positions or heartbeats', () => {
    expect(isHighPriority({ type: 'session.start' })).toBe(true)
    expect(isHighPriority({ type: 'interact', data: { kind: 'click' } })).toBe(true)
    expect(isHighPriority({ type: 'interact', data: { kind: 'hover' } })).toBe(false)
    expect(isHighPriority({ type: 'pos' })).toBe(false)
    expect(isHighPriority({ type: 'session.heartbeat' })).toBe(false)
    expect(ANALYTICS_LIMITS.maxBatchEvents).toBe(100)
  })
})
