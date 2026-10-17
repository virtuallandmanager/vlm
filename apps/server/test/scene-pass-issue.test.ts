import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { verifySessionToken } from '../src/auth/tokens.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene } from './helpers/factories.js'
import { createAnalyticsScene } from './helpers/analytics.js'
import { createSetup } from './helpers/setups.js'

const W = '0x00000000000000000000000000000000000000a1'
vi.mock('../src/middleware/dcl-auth.js', () => ({
  hasDclAuthHeaders: (h: Record<string, unknown>) => !!h['x-identity-auth-chain-0'],
  verifyDclSignedFetch: async () => { throw new Error('unused') },
  verifyDclSceneRequest: async (_m: string, _p: string, h: Record<string, string>) => {
    const v = h['x-identity-auth-chain-0']
    if (v !== 'valid') throw new Error('bad')
    return { wallet: W, scene: { sceneId: h['x-test-entity'] ?? 'bafyA', parcel: h['x-test-parcel'] ?? '10,20', realm: { hostname: 'peer.decentraland.org', serverName: 'main' }, isGuest: false } }
  },
}))

describe('platform sign-in → scene pass', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); app = await testApp() })
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
})
