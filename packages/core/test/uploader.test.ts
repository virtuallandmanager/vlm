import { describe, it, expect, vi } from 'vitest'
import { EventQueue } from '../src/analytics/queue.js'
import { Uploader } from '../src/analytics/uploader.js'
import type { AnalyticsTransport } from '../src/analytics/transport.js'
import type { AnalyticsEvent } from 'vlm-shared'

const ev = (type: AnalyticsEvent['type'], seq: number, data?: Record<string, unknown>): AnalyticsEvent => ({ t: 0, type, seq, data })

function setup(responses: Array<{ status: number; body?: unknown }>) {
  let now = 0
  const queue = new EventQueue(10)
  const sent: any[] = []
  const transport: AnalyticsTransport = {
    send: vi.fn(async (_url, batch) => {
      sent.push(batch)
      return responses.shift() ?? { status: 200, body: { ok: true, accepted: batch.events.length, notice: false } }
    }),
  }
  const onResponse = vi.fn()
  const up = new Uploader({
    url: 'http://x/api/ingest',
    queue,
    transport,
    envelope: (sessionId) => ({ v: 1, sessionId, visitorId: 'v', isGuest: true, noticeShown: false, scene: { realm: 'main', isWorld: false, isPreview: false, baseParcel: '0,0' } }),
    now: () => now,
    random: () => 1,
    onResponse,
  })
  return { queue, up, sent, transport, onResponse, advance: (ms: number) => (now += ms) }
}

describe('EventQueue', () => {
  it('evicts oldest pos, then oldest heartbeat, then oldest event when full', () => {
    const q = new EventQueue(3)
    q.push('s', ev('session.heartbeat', 0))
    q.push('s', ev('pos', 1))
    q.push('s', ev('custom', 2))
    q.push('s', ev('custom', 3)) // evicts pos
    q.push('s', ev('custom', 4)) // evicts heartbeat
    q.push('s', ev('custom', 5)) // evicts oldest (seq 2)
    expect(q.take(10)!.events.map((e) => e.seq)).toEqual([3, 4, 5])
  })

  it('take returns only the leading run of one session', () => {
    const q = new EventQueue(10)
    q.push('a', ev('pos', 0))
    q.push('a', ev('pos', 1))
    q.push('b', ev('session.start', 0))
    expect(q.take(10)).toEqual({ sessionId: 'a', events: [ev('pos', 0), ev('pos', 1)] })
    expect(q.take(10)!.sessionId).toBe('b')
  })
})

describe('Uploader', () => {
  it('waits for 5 s of low-priority events, then flushes', async () => {
    const s = setup([])
    s.queue.push('s', ev('pos', 0))
    expect(s.up.maybeFlush()).toBeNull()
    s.advance(5_000)
    await s.up.maybeFlush()
    expect(s.sent).toHaveLength(1)
  })

  it('flushes immediately for a high-priority event', async () => {
    const s = setup([])
    s.queue.push('s', ev('interact', 0, { kind: 'click', target: 'door' }))
    await s.up.maybeFlush()
    expect(s.sent).toHaveLength(1)
  })

  it('does not start a second send while one is in flight', async () => {
    const s = setup([])
    s.queue.push('s', ev('session.start', 0))
    const p = s.up.maybeFlush()
    s.queue.push('s', ev('session.leave', 1))
    expect(s.up.maybeFlush()).toBeNull()
    await p
  })

  it('puts events back and backs off on 5xx and network errors', async () => {
    const s = setup([{ status: 503 }, { status: 0 }])
    s.queue.push('s', ev('session.start', 0))
    await s.up.maybeFlush()
    expect(s.queue.size).toBe(1)
    expect(s.up.maybeFlush()).toBeNull() // inside 1 s backoff
    s.advance(1_000)
    await s.up.maybeFlush()
    expect(s.queue.size).toBe(1)
    s.advance(1_999)
    expect(s.up.maybeFlush()).toBeNull() // second failure → 2 s backoff
    s.advance(1)
    await s.up.maybeFlush()
    expect(s.queue.size).toBe(0)
  })

  it('honors retryAfter on 429', async () => {
    const s = setup([{ status: 429, body: { retryAfter: 7 } }])
    s.queue.push('s', ev('session.start', 0))
    await s.up.maybeFlush()
    s.advance(6_999)
    expect(s.up.maybeFlush()).toBeNull()
    s.advance(1)
    await s.up.maybeFlush()
    expect(s.sent).toHaveLength(2)
  })

  it('drops the batch on other 4xx', async () => {
    const s = setup([{ status: 422, body: { error: 'unknown_scene' } }])
    s.queue.push('s', ev('session.start', 0))
    await s.up.maybeFlush()
    expect(s.queue.size).toBe(0)
  })

  it('passes the server response to onResponse', async () => {
    const s = setup([{ status: 200, body: { ok: true, accepted: 1, notice: true } }])
    s.queue.push('s', ev('session.start', 0))
    await s.up.maybeFlush()
    expect(s.onResponse).toHaveBeenCalledWith({ ok: true, accepted: 1, notice: true })
  })
})
