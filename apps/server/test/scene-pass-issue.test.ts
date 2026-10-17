import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { verifySessionToken } from '../src/auth/tokens.js'
import { resetDb } from './helpers/db.js'
import { config } from '../src/config.js'
import { testApp, createUser, createScene } from './helpers/factories.js'
import { createAnalyticsScene } from './helpers/analytics.js'
import { createSetup } from './helpers/setups.js'

const h = vi.hoisted(() => ({ calls: [] as any[][], bindFails: false }))
const W = '0x00000000000000000000000000000000000000a1'
vi.mock('../src/middleware/dcl-auth.js', () => ({
  hasDclAuthHeaders: (h: Record<string, unknown>) => !!h['x-identity-auth-chain-0'],
  verifyDclSignedFetch: async () => { throw new Error('unused') },
  verifyDclSceneRequest: async (...args: any[]) => {
    h.calls.push(args)
    const hd = args[2] as Record<string, string>
    if (hd['x-identity-auth-chain-0'] !== 'valid') throw new Error('bad')
    return { wallet: W, scene: { sceneId: hd['x-test-entity'] ?? 'bafyA', parcel: hd['x-test-parcel'] ?? '10,20', realm: { hostname: 'peer.decentraland.org', serverName: 'main' }, isGuest: hd['x-test-guest'] === '1' } }
  },
}))
vi.mock('../src/auth/scene-binding.js', async (orig) => {
  const real = await orig<typeof import('../src/auth/scene-binding.js')>()
  return { ...real, bindSceneRequest: async (...a: Parameters<typeof real.bindSceneRequest>) => { if (h.bindFails) throw new Error('db exploded'); return real.bindSceneRequest(...a) } }
})

describe('platform sign-in → scene pass', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { h.calls.length = 0; h.bindFails = false; await resetDb(); app = await testApp() })
  afterEach(async () => { await app.close() })

  const signIn = (headers: Record<string, string> = {}, payload: unknown = { user: { displayName: 'A' } }) =>
    app.inject({ method: 'POST', url: '/api/auth/platform', headers: { 'x-identity-auth-chain-0': 'valid', ...headers }, payload: payload as any })

  it('binds to the set-up scene at the signed parcel', async () => {
    const owner = await createUser({ wallet: W })
    const { scene } = await createScene(owner)
    const loc = await createAnalyticsScene({ locationKey: 'gc:10,20', baseParcel: '10,20', parcels: ['10,20'] } as any)
    await createSetup(loc.id, scene.id)
    const res = await signIn()
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.scene).toEqual({ sceneId: scene.id, locationId: loc.id })
    const c = verifySessionToken(body.accessToken)!
    expect(c).toMatchObject({ kind: 'scene', sceneId: scene.id, locationId: loc.id, wallet: W, verified: true, orgId: null })
  })

  it('ignores a body sceneId that disagrees with the setup', async () => {
    const owner = await createUser({ wallet: W })
    const { scene } = await createScene(owner)
    const other = (await createScene(owner, 'Other')).scene
    const loc = await createAnalyticsScene({ locationKey: 'gc:10,20', baseParcel: '10,20', parcels: ['10,20'] } as any)
    await createSetup(loc.id, scene.id)
    const res = await signIn({}, { sceneId: other.id, user: {} })
    expect(res.json().scene.sceneId).toBe(scene.id)
  })

  it('no setup at the parcel → visitor pass', async () => {
    const res = await signIn({ 'x-test-parcel': '99,99' })
    expect(res.json().scene).toEqual({ sceneId: null, locationId: null })
    expect(verifySessionToken(res.json().accessToken)).toMatchObject({ kind: 'scene', sceneId: null })
  })

  it('a bad signature still gets a guest token', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/platform', headers: { 'x-identity-auth-chain-0': 'forged' }, payload: {} })
    expect(res.json().guest).toBe(true)
  })

  it('invalid JSON body is a 400, not a 500', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/platform', headers: { 'content-type': 'application/json' }, payload: '{nope' })
    expect(res.statusCode).toBe(400)
  })

  it('refresh keeps the pass bound and never upgrades it', async () => {
    const owner = await createUser({ wallet: W })
    const { scene } = await createScene(owner)
    const loc = await createAnalyticsScene({ locationKey: 'gc:10,20', baseParcel: '10,20', parcels: ['10,20'] } as any)
    await createSetup(loc.id, scene.id)
    const { refreshToken } = (await signIn()).json()
    const r = await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { authorization: `Bearer ${refreshToken}` } })
    expect(verifySessionToken(r.json().accessToken)).toMatchObject({ kind: 'scene', sceneId: scene.id, locationId: loc.id, orgId: null })
  })

  it('passes the exact raw body and the query-less path to verification', async () => {
    const raw = '{"user":{"displayName":"A"},  "x": 1}'
    const res = await app.inject({ method: 'POST', url: '/api/auth/platform?foo=bar', headers: { 'x-identity-auth-chain-0': 'valid', 'content-type': 'application/json' }, payload: raw })
    expect(res.statusCode).toBe(200)
    expect(h.calls[0][0]).toBe('POST')
    expect(h.calls[0][1]).toBe('/api/auth/platform')
    expect(h.calls[0][3]).toBe(raw)
  })

  it('a signed guest (isGuest) gets a guest token', async () => {
    const res = await signIn({ 'x-test-guest': '1' })
    expect(res.json().guest).toBe(true)
    expect(verifySessionToken(res.json().accessToken)).toMatchObject({ guest: true })
  })

  it('a binding failure still yields a verified visitor pass', async () => {
    h.bindFails = true
    const res = await signIn()
    expect(res.statusCode).toBe(200)
    expect(res.json().scene).toEqual({ sceneId: null, locationId: null })
    expect(verifySessionToken(res.json().accessToken)).toMatchObject({ kind: 'scene', sceneId: null, verified: true, wallet: W })
  })

  it('refuses a prototype-poisoning body with 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/platform', headers: { 'content-type': 'application/json' }, payload: '{"__proto__":{"x":1}}' })
    expect(res.statusCode).toBe(400)
  })

  describe('unverified preview path', () => {
    afterEach(() => { (config as any).allowUnverifiedPlatformAuth = false; (config as any).mode = 'single' })
    const prev = (payload: unknown) => app.inject({ method: 'POST', url: '/api/auth/platform', payload: payload as any })

    it('is not taken in cloud mode', async () => {
      ;(config as any).allowUnverifiedPlatformAuth = true
      ;(config as any).mode = 'cloud'
      const res = await prev({ user: { id: 'p1' } })
      expect(res.json().guest).toBe(true)
    })

    it('binds to an existing body sceneId, and refresh keeps kind/verified/sceneId', async () => {
      ;(config as any).allowUnverifiedPlatformAuth = true
      const owner = await createUser({ wallet: W })
      const { scene } = await createScene(owner)
      const login = await prev({ sceneId: scene.id, user: { id: 'p1' } })
      const c = verifySessionToken(login.json().accessToken)!
      expect(c).toMatchObject({ kind: 'scene', verified: false, sceneId: scene.id, locationId: null, orgId: null, email: null })
      const r = await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { authorization: `Bearer ${login.json().refreshToken}` } })
      const rc = verifySessionToken(r.json().accessToken)!
      expect(rc).toMatchObject({ kind: 'scene', verified: false, sceneId: scene.id, locationId: null, orgId: null, email: null })
      expect(rc.wallet ?? null).toBeNull()
    })
  })
})
