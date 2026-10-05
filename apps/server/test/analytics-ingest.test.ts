import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { analyticsEvents, analyticsPositions, analyticsSessions, analyticsScenes, analyticsDirtyHours } from '../src/db/schema.js'
import { setDclDirectory } from '../src/analytics/dcl-directory.js'
import { clearRegistryCache } from '../src/analytics/registry.js'
import { visitorHash } from '../src/analytics/hash.js'
import { TokenBucketLimiter } from '../src/analytics/limiter.js'
import { setIngestLimiter } from '../src/routes/ingest.js'
import { resetDb } from './helpers/db.js'
import { testApp } from './helpers/factories.js'
import { FakeDclDirectory } from './helpers/fake-dcl.js'

vi.mock('../src/middleware/dcl-auth.js', () => ({
  hasDclAuthHeaders: (h: Record<string, unknown>) => !!h['x-identity-auth-chain-0'],
  verifyDclSignedFetch: async (_m: string, _p: string, h: Record<string, string>) => {
    const v = h['x-identity-auth-chain-0']
    if (typeof v === 'string' && v.startsWith('valid:')) return { walletAddress: v.slice(6), metadata: {} }
    throw new Error('bad signature')
  },
}))

const WALLET = '0x00000000000000000000000000000000000000aa'
const SID = '22222222-2222-4222-8222-222222222222'
const signed = (w = WALLET) => ({ 'x-identity-auth-chain-0': `valid:${w}` })

function batch(o: Record<string, unknown> = {}) {
  const now = Date.now()
  return {
    v: 1,
    sessionId: SID,
    visitorId: WALLET,
    isGuest: false,
    noticeShown: false,
    scene: { realm: 'main', isWorld: false, isPreview: false, baseParcel: '10,10', parcels: ['10,10'], entityId: 'bafyA' },
    events: [
      { t: now - 3000, type: 'session.start', seq: 0, data: { platform: 'decentraland', device: 'desktop', realm: 'main', cameraMode: 'third', isGuest: false } },
      { t: now - 2000, type: 'pos', seq: 1, data: { x: 3.2, y: 0, z: 4.1, ry: 90, m: true } },
      { t: now - 1000, type: 'interact', seq: 2, data: { kind: 'click', target: 'door' } },
    ],
    ...o,
  }
}

describe('POST /api/ingest', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let dir: FakeDclDirectory
  beforeEach(async () => {
    await resetDb()
    clearRegistryCache()
    setIngestLimiter(new TokenBucketLimiter())
    dir = new FakeDclDirectory()
    dir.addScene({ entityId: 'bafyA', base: '10,10', parcels: ['10,10'], title: 'Caldera' })
    setDclDirectory(dir)
    app = await testApp()
  })
  afterEach(async () => {
    setDclDirectory(null)
    await app.close()
  })

  const post = (body: unknown, headers: Record<string, string> = signed()) =>
    app.inject({ method: 'POST', url: '/api/ingest', payload: body as any, headers })

  it('stores a verified batch: session, events, positions, dirty hours, hashed identity only', async () => {
    const res = await post(batch())
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, accepted: 3, notice: false })
    const scene = (await db.select().from(analyticsScenes))[0]
    const [session] = await db.select().from(analyticsSessions)
    expect(session).toMatchObject({ id: SID, sceneId: scene.id, verified: true, isGuest: false, platform: 'decentraland', device: 'desktop', cameraMode: 'third', eventCount: 3, wallet: null, displayName: null, isReturning: false })
    expect(session.visitorHash).toBe(visitorHash(scene.salt, WALLET))
    expect(await db.select().from(analyticsEvents)).toHaveLength(2) // session.start + interact
    const [p] = await db.select().from(analyticsPositions)
    expect(p).toMatchObject({ x: 3.2, z: 4.1, heading: 90, moving: true })
    expect((await db.select().from(analyticsDirtyHours)).length).toBeGreaterThanOrEqual(1)
  })

  it('ingest bumps the scene last_activity_at', async () => {
    await post(batch())
    const [scene] = await db.select().from(analyticsScenes)
    expect(scene.lastActivityAt).not.toBeNull()
    expect(Date.now() - scene.lastActivityAt!.getTime()).toBeLessThan(10_000)
  })

  it('retrying the same batch does not double count', async () => {
    await post(batch())
    const again = await post(batch())
    expect(again.statusCode).toBe(200)
    expect(again.json().accepted).toBe(0)
    const [session] = await db.select().from(analyticsSessions)
    expect(session.eventCount).toBe(3)
    expect(await db.select().from(analyticsEvents)).toHaveLength(2)
  })

  it('unsigned batches are stored as unverified', async () => {
    const res = await post(batch(), {})
    expect(res.statusCode).toBe(200)
    expect((await db.select().from(analyticsSessions))[0].verified).toBe(false)
  })

  it('a signer that does not match visitorId is rejected', async () => {
    expect((await post(batch(), signed('0x00000000000000000000000000000000000000bb'))).statusCode).toBe(400)
  })

  it('bad shape → 400, unknown scene → 422, directory down for a new scene → 503', async () => {
    expect((await post({ v: 1 })).statusCode).toBe(400)
    expect((await post(batch({ scene: { realm: 'main', isWorld: false, isPreview: false, baseParcel: '99,99' } }))).statusCode).toBe(422)
    dir.down = true
    const r = await post(batch({ scene: { realm: 'main', isWorld: false, isPreview: false, baseParcel: '77,77' } }))
    expect(r.statusCode).toBe(503)
    expect(r.json().retryAfter).toBe(30)
  })

  it('session.leave closes the session; later events reopen it', async () => {
    await post(batch())
    await post(batch({ events: [{ t: Date.now(), type: 'session.leave', seq: 3, data: { reason: 'left_parcels' } }] }))
    expect((await db.select().from(analyticsSessions))[0].endedAt).not.toBeNull()
    await post(batch({ events: [{ t: Date.now() + 1000, type: 'session.heartbeat', seq: 4, data: {} }] }))
    expect((await db.select().from(analyticsSessions))[0].endedAt).toBeNull()
  })

  it('a session id reused for another scene is rejected with 409', async () => {
    await post(batch())
    dir.addScene({ entityId: 'bafyC', base: '20,20', parcels: ['20,20'] })
    const r = await post(batch({ scene: { realm: 'main', isWorld: false, isPreview: false, baseParcel: '20,20', parcels: ['20,20'] }, events: [{ t: Date.now(), type: 'session.heartbeat', seq: 9, data: {} }] }))
    expect(r.statusCode).toBe(409)
  })

  it('marks returning visitors', async () => {
    await post(batch())
    await post(batch({ sessionId: '33333333-3333-4333-8333-333333333333' }))
    const rows = await db.select().from(analyticsSessions).where(eq(analyticsSessions.id, '33333333-3333-4333-8333-333333333333'))
    expect(rows[0].isReturning).toBe(true)
  })

  it('stores plain identity only when visibility is on, the notice was shown, and the visitor is not a guest', async () => {
    await post(batch())
    await db.update(analyticsScenes).set({ walletVisibility: true })
    const res = await post(batch({ sessionId: '44444444-4444-4444-8444-444444444444', noticeShown: true, displayName: 'Ana' }))
    expect(res.json().notice).toBe(true)
    const [s] = await db.select().from(analyticsSessions).where(eq(analyticsSessions.id, '44444444-4444-4444-8444-444444444444'))
    expect(s).toMatchObject({ wallet: WALLET, displayName: 'Ana' })
    await post(batch({ sessionId: '55555555-5555-4555-8555-555555555555', noticeShown: false, displayName: 'Ana' }))
    const [hidden] = await db.select().from(analyticsSessions).where(eq(analyticsSessions.id, '55555555-5555-4555-8555-555555555555'))
    expect(hidden).toMatchObject({ wallet: null, displayName: null })
  })

  it('rate limits with 429 and retryAfter', async () => {
    for (let i = 0; i < 3; i++) await post(batch({ sessionId: `6666666${i}-6666-4666-8666-666666666666` }))
    const r = await post(batch({ sessionId: '66666669-6666-4666-8666-666666666666' }))
    expect(r.statusCode).toBe(429)
    expect(r.json().retryAfter).toBeGreaterThan(0)
  })

  it('per-IP limit applies to verified traffic: fresh wallets from one IP are capped at a 10-request burst', async () => {
    setIngestLimiter(new TokenBucketLimiter(() => 0))
    const codes: number[] = []
    for (let i = 0; i < 11; i++) {
      const w = `0x${(0xb00 + i).toString(16).padStart(40, '0')}`
      const sid = `7777777${i.toString(16)}-7777-4777-8777-777777777777`
      codes.push((await post(batch({ visitorId: w, sessionId: sid }), signed(w))).statusCode)
    }
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true)
    expect(codes[10]).toBe(429)
  })

  it('caps new preview rows per IP per UTC day at 20', async () => {
    let t = 0
    setIngestLimiter(new TokenBucketLimiter(() => (t += 1_000)))
    const preview = { realm: 'localhost', isWorld: false, isPreview: true, baseParcel: '0,0', parcels: ['0,0'] }
    const send = (i: number) => {
      const w = `0x${(0xc00 + i).toString(16).padStart(40, '0')}`
      const sid = `88888888-8888-4888-8888-${i.toString(16).padStart(12, '0')}`
      return post(batch({ visitorId: w, sessionId: sid, scene: preview }), signed(w))
    }
    for (let i = 0; i < 20; i++) expect((await send(i)).statusCode).toBe(200)
    const over = await send(20)
    expect(over.statusCode).toBe(429)
    expect(over.json()).toMatchObject({ error: 'rate_limited' })
    expect(await db.select().from(analyticsScenes)).toHaveLength(20)
    // An existing preview row still accepts batches.
    const w0 = `0x${(0xc00).toString(16).padStart(40, '0')}`
    expect((await post(batch({ visitorId: w0, sessionId: '88888888-8888-4888-8888-000000000000', scene: preview }), signed(w0))).statusCode).toBe(200)
  })

  it('rejects NUL characters with 400', async () => {
    const b = batch({ events: [{ t: Date.now(), type: 'custom', seq: 0, data: { name: 'a\u0000b' } }] })
    expect((await post(b)).statusCode).toBe(400)
  })

  it('a deeply nested NUL returns 400, not 500', async () => {
    let data: unknown = 'a\u0000b'
    for (let i = 0; i < 18; i++) data = { k: data }
    const r = await post(batch({ events: [{ t: Date.now(), type: 'custom', seq: 0, data }] }))
    expect(r.statusCode).toBe(400)
  })

  it('drops out-of-range positions and normalizes heading', async () => {
    const now = Date.now()
    const res = await post(batch({ events: [
      { t: now - 3000, type: 'pos', seq: 0, data: { x: 1e300, y: 0, z: 0, ry: 0, m: false } },
      { t: now - 2000, type: 'pos', seq: 1, data: { x: 1, y: 0, z: 2, ry: -90, m: false } },
    ] }))
    expect(res.statusCode).toBe(200)
    const ps = await db.select().from(analyticsPositions)
    expect(ps).toHaveLength(1)
    expect(ps[0].heading).toBe(270)
  })

  it('does not reveal identity for an unsigned batch even with visibility on and notice shown', async () => {
    await post(batch())
    await db.update(analyticsScenes).set({ walletVisibility: true })
    const id = '77777777-7777-4777-8777-777777777777'
    await post(batch({ sessionId: id, noticeShown: true, displayName: 'Ana' }), {})
    const [s] = await db.select().from(analyticsSessions).where(eq(analyticsSessions.id, id))
    expect(s).toMatchObject({ wallet: null, displayName: null, verified: false })
  })

  it('a session id reused by a different visitor is rejected with 409 and the hash is unchanged', async () => {
    await post(batch())
    const [before] = await db.select().from(analyticsSessions)
    const other = '0x00000000000000000000000000000000000000bb'
    const r = await post(batch({ visitorId: other, events: [{ t: Date.now(), type: 'session.heartbeat', seq: 9, data: {} }] }), signed(other))
    expect(r.statusCode).toBe(409)
    const [after] = await db.select().from(analyticsSessions)
    expect(after.visitorHash).toBe(before.visitorHash)
    expect((await db.select().from(analyticsEvents)).some((e) => e.seq === 9)).toBe(false)
  })

  it('never stores the IP address', async () => {
    await post(batch(), { ...signed(), 'x-forwarded-for': '203.0.113.9' })
    const dump = JSON.stringify(await db.select().from(analyticsSessions)) + JSON.stringify(await db.select().from(analyticsEvents))
    expect(dump).not.toContain('203.0.113.9')
  })
})
