import { describe, it, expect, afterEach, vi } from 'vitest'
import { buildApp } from '../src/app.js'

vi.mock('../src/analytics/writer.js', async (orig) => ({
  ...(await orig<typeof import('../src/analytics/writer.js')>()),
  writeBatch: async () => {
    throw new Error('db down')
  },
}))
vi.mock('../src/analytics/registry.js', async (orig) => ({
  ...(await orig<typeof import('../src/analytics/registry.js')>()),
  resolveAnalyticsScene: async () => ({ ok: true, scene: { id: 's', salt: '00', walletVisibility: false, isPreview: false } }),
}))

describe('POST /api/ingest errors', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  afterEach(async () => app.close())

  it('returns 500 and never logs the client IP', async () => {
    const lines: string[] = []
    app = await buildApp({ rateLimit: false, logStream: { write: (m) => void lines.push(m) } })
    await app.ready()
    const now = Date.now()
    const res = await app.inject({
      method: 'POST',
      url: '/api/ingest',
      headers: { 'x-forwarded-for': '203.0.113.9' },
      remoteAddress: '203.0.113.9',
      payload: {
        v: 1,
        sessionId: '22222222-2222-4222-8222-222222222222',
        visitorId: 'guest-1',
        isGuest: true,
        noticeShown: false,
        scene: { realm: 'main', isWorld: false, isPreview: false, baseParcel: '10,10' },
        events: [{ t: now, type: 'session.heartbeat', seq: 0, data: {} }],
      } as any,
    })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'internal_error' })
    const text = lines.join('')
    expect(text).toContain('ingest failed')
    expect(text).not.toContain('203.0.113.9')
  })
})
