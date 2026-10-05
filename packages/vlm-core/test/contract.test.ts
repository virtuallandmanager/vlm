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

describe('checkBatch', () => {
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
