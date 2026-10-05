import { describe, it, expect, afterEach, vi } from 'vitest'
import { testApp } from './helpers/factories.js'

// An unverified batch can't exceed 100 events (checkBatch caps it), so a tooLarge result is
// unreachable over HTTP with real limits. Stub the requester check to verify the route's mapping.
vi.mock('../src/analytics/limiter.js', async (orig) => ({
  ...(await orig<typeof import('../src/analytics/limiter.js')>()),
  checkRequesterLimits: () => ({ ok: false, retryAfterMs: 0, tooLarge: true }),
}))

describe('POST /api/ingest limit mapping', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  afterEach(async () => app.close())

  it('maps a tooLarge requester result to 413 batch_too_large without retryAfter', async () => {
    app = await testApp()
    const now = Date.now()
    const res = await app.inject({
      method: 'POST',
      url: '/api/ingest',
      payload: {
        v: 1,
        sessionId: '22222222-2222-4222-8222-222222222222',
        visitorId: '0x00000000000000000000000000000000000000aa',
        isGuest: false,
        noticeShown: false,
        scene: { realm: 'main', isWorld: false, isPreview: false, baseParcel: '10,10' },
        events: [{ t: now - 1000, type: 'session.heartbeat', seq: 0, data: {} }],
      } as any,
    })
    expect(res.statusCode).toBe(413)
    expect(res.json()).toEqual({ error: 'batch_too_large' })
  })
})
