import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Wallet } from 'ethers'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, createElement, createInstance, tokenFor } from './helpers/factories.js'
import { createAnalyticsScene } from './helpers/analytics.js'
import { createSetup } from './helpers/setups.js'
import { verifySessionToken } from '../src/auth/tokens.js'

const pass = (u: any, sceneId: string | null, locationId: string | null = null) => tokenFor(u, { kind: 'scene', sceneId, locationId, orgId: null })

// Routes that never read a bearer token (signed fetch, webhook keys, codes, public browse, static).
// A new public route must be added here deliberately, with its reason.
// Exact `METHOD url` matches.
const PUBLIC_EXACT = [
  'POST /api/auth/register', // creates an account from email + password; no bearer
  'POST /api/auth/login', // email + password; no bearer
  'POST /api/auth/refresh', // takes a refresh token only; an access token (pass or account) gets 401 "Not a refresh token"
  'POST /api/auth/platform', // DCL signed fetch; issues the pass
  'GET /api/auth/providers', // static list of enabled sign-in providers
  'POST /api/auth/forgot-password', // email only
  'POST /api/auth/reset-password', // reset token in body
  'POST /api/auth/wallet/challenge', // nonce for an address; no bearer
  'POST /api/auth/handoff/exchange', // single-use code in body
  'POST /api/setup', // DCL signed fetch (location setup)
  'POST /api/setup/status', // DCL signed fetch (location setup status)
  'GET /api/setup/scene', // public: VLM scene for a set-up location (guest content-only connect)
  'GET /api/setup/models', // public: model list for a set-up location
  'GET /api/hyperfy/feed', // world-key auth
  'POST /api/hyperfy/analytics', // world-key auth
  'GET /api/hyperfy/app.hyp', // public: the built VLM Hyperfy app download
  'POST /api/ingest', // DCL signed fetch / ingest key
  'POST /api/analytics/claims/check-signed', // DCL signed fetch
  'POST /api/streaming/authorize', // media server callback, shared secret
  'GET /api/streaming/live-keys', // media server callback, shared secret
  'POST /api/streaming/webhook', // media server callback, shared secret
  'POST /api/billing/webhook', // Stripe signature
  'GET /api/assets', // public browse list (never reads a bearer)
  'GET /api/assets/:id', // public asset detail
  'GET /api/assets/categories', // public category list
  'GET /api/catalog/packs', // public credits list (no bearer)
  'GET /api/health', // health check
  'GET /metrics', // Prometheus scrape
  'GET /', // static dashboard
  'GET /*', // static dashboard files
]
// startsWith matches — only genuinely prefixed families.
const PUBLIC_PREFIX = [
  'GET /api/auth/google', // OAuth redirect + callback
  'GET /api/auth/discord', // OAuth redirect + callback
  'GET /api/upload/', // companion upload: the code is the auth
  'POST /api/upload/', // companion upload: the code is the auth
  'GET /hook/', // platform hooks: per-hook secret in the URL
  'POST /hook/', // platform hooks: per-hook secret in the URL
  'GET /api/docs', // Swagger UI and its static files
  'GET /uploads/', // static uploaded media
]
// Read an optional bearer but treat a scene pass as no bearer (so the walk cannot see a 403).
// Each entry has its own test below.
const IGNORES_SCENE_PASS = [
  'POST /api/auth/wallet/verify', // a pass never links a wallet; it signs in as the wallet instead
]
const isPublic = (method: string, url: string) => {
  const key = `${method} ${url}`
  return PUBLIC_EXACT.includes(key) || PUBLIC_PREFIX.some((p) => key.startsWith(p)) || IGNORES_SCENE_PASS.includes(key)
}

describe('scene pass guard', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(async () => { await app.close() })

  it('every route without scenePass config refuses a scene pass (route walk)', async () => {
    const owner = await createUser({ wallet: '0x00000000000000000000000000000000000000a1' })
    const { scene } = await createScene(owner)
    const t = pass(owner, scene.id)
    // Collected by the onRoute hook installed in app.ts.
    const all = (app as any).registeredRoutes as Array<{ method: string; url: string; scenePass: boolean }>
    expect(all.length).toBeGreaterThan(50)
    const offenders: string[] = []
    for (const r of all.filter((r) => !r.scenePass && !isPublic(r.method, r.url))) {
      const url = r.url.replace(/:sceneId/g, scene.id).replace(/:[A-Za-z]+/g, '00000000-0000-0000-0000-000000000000')
      const res = await app.inject({ method: r.method as any, url, headers: { authorization: `Bearer ${t}` }, payload: {} })
      let error: unknown
      try { error = res.json().error } catch { error = undefined }
      if (res.statusCode !== 403 || error !== 'scene_pass_not_allowed') offenders.push(`${r.method} ${r.url} → ${res.statusCode}`)
    }
    expect(offenders).toEqual([])
  })

  it('every PUBLIC_EXACT entry is a registered route (no stale entries)', async () => {
    const keys = new Set(((app as any).registeredRoutes as Array<{ method: string; url: string }>).map((r) => `${r.method} ${r.url}`))
    const missing = [...PUBLIC_EXACT, ...IGNORES_SCENE_PASS].filter((k) => !keys.has(k) && k !== 'GET /' && k !== 'GET /*' && k !== 'GET /metrics')
    expect(missing).toEqual([])
  })

  it('POST /api/auth/wallet/verify treats a scene pass as no bearer (signs in, never links)', async () => {
    const owner = await createUser()
    const { scene } = await createScene(owner)
    const w = Wallet.createRandom()
    const ch = await app.inject({ method: 'POST', url: '/api/auth/wallet/challenge', payload: { address: w.address } })
    const { nonce, message } = ch.json()
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/wallet/verify',
      payload: { address: w.address, nonce, signature: await w.signMessage(message) },
      headers: { authorization: `Bearer ${pass(owner, scene.id)}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().linked).toBeUndefined()
    const claims = verifySessionToken(res.json().accessToken)
    expect(claims?.kind).toBe('account')
    expect(claims?.id).not.toBe(owner.id)
  })

  it('POST /api/auth/refresh refuses a scene access pass', async () => {
    const owner = await createUser()
    const { scene } = await createScene(owner)
    const res = await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { authorization: `Bearer ${pass(owner, scene.id)}` } })
    expect(res.statusCode).toBe(401)
  })

  it('POST /api/auth/handoff keeps its scenePass config through the auth scope (bound pass allowed, visitor pass refused)', async () => {
    const owner = await createUser({ wallet: '0x00000000000000000000000000000000000000b2' })
    const { scene } = await createScene(owner)
    const routes = (app as any).registeredRoutes as Array<{ method: string; url: string; scenePass: boolean }>
    expect(routes.find((r) => r.method === 'POST' && r.url === '/api/auth/handoff')?.scenePass).toBe(true)
    const ok = await app.inject({ method: 'POST', url: '/api/auth/handoff', headers: { authorization: `Bearer ${pass(owner, scene.id)}` } })
    expect(ok.statusCode).toBe(200)
    const visitor = await app.inject({ method: 'POST', url: '/api/auth/handoff', headers: { authorization: `Bearer ${pass(owner, null)}` } })
    expect(visitor.statusCode).toBe(403)
    expect(visitor.json().error).toBe('scene_pass_not_allowed')
  })

  it('a pass for scene A is refused on scene B for each allowed route', async () => {
    const owner = await createUser()
    const a = await createScene(owner, 'A')
    const b = await createScene(owner, 'B')
    const el = await createElement(b.preset.id)
    const inst = await createInstance(el.id)
    const t = pass(owner, a.scene.id)
    const h = { authorization: `Bearer ${t}` }
    const reqs: Array<[string, string]> = [
      ['GET', `/api/scenes/${b.scene.id}`], ['PUT', `/api/scenes/${b.scene.id}`],
      ['POST', `/api/presets/${b.preset.id}/elements`], ['PUT', `/api/elements/${el.id}`], ['DELETE', `/api/elements/${el.id}`],
      ['POST', `/api/elements/${el.id}/instances`], ['PUT', `/api/instances/${inst.id}`], ['DELETE', `/api/instances/${inst.id}`],
      ['GET', `/api/scenes/${b.scene.id}/roles`], ['POST', `/api/scenes/${b.scene.id}/roles`],
      ['DELETE', `/api/scenes/${b.scene.id}/roles/0xabc`], ['POST', `/api/scenes/${b.scene.id}/transfer-host`],
    ]
    for (const [method, url] of reqs) {
      const res = await app.inject({ method: method as any, url, headers: h, payload: {} })
      expect([method, url, res.statusCode]).toEqual([method, url, 403])
      expect(res.json().error).toBe('scene_pass_not_allowed')
    }
    const up = await app.inject({ method: 'POST', url: '/api/upload-tokens', headers: h, payload: { sceneId: b.scene.id } })
    expect(up.statusCode).toBe(403)
  })

  it('a visitor pass (sceneId null) is refused on every allowed route', async () => {
    const owner = await createUser()
    const a = await createScene(owner, 'A')
    const res = await app.inject({ method: 'GET', url: `/api/scenes/${a.scene.id}`, headers: { authorization: `Bearer ${pass(owner, null)}` } })
    expect(res.statusCode).toBe(403)
    const list = await app.inject({ method: 'GET', url: '/api/scenes', headers: { authorization: `Bearer ${pass(owner, null)}` } })
    expect(list.statusCode).toBe(403)
  })

  it('unknown element id under a pass → 403, not 500', async () => {
    const owner = await createUser()
    const a = await createScene(owner, 'A')
    const res = await app.inject({ method: 'PUT', url: '/api/elements/00000000-0000-0000-0000-000000000000', headers: { authorization: `Bearer ${pass(owner, a.scene.id)}` }, payload: {} })
    expect(res.statusCode).toBe(403)
    const bad = await app.inject({ method: 'PUT', url: '/api/instances/not-a-uuid', headers: { authorization: `Bearer ${pass(owner, a.scene.id)}` }, payload: {} })
    expect(bad.statusCode).toBe(403)
    expect(bad.json().error).toBe('scene_pass_not_allowed')
  })

  it('GET /api/scenes with a pass returns only the bound scene', async () => {
    const owner = await createUser()
    const a = await createScene(owner, 'A')
    await createScene(owner, 'B')
    const res = await app.inject({ method: 'GET', url: '/api/scenes', headers: { authorization: `Bearer ${pass(owner, a.scene.id)}` } })
    expect(res.json().scenes.map((s: any) => s.id)).toEqual([a.scene.id])
    expect(res.json().scenes[0].relationship).toBe('owner')
  })

  it('GET /api/scenes with a pass for a scene the user cannot reach returns nothing', async () => {
    const owner = await createUser()
    const stranger = await createUser()
    const a = await createScene(owner, 'A')
    const res = await app.inject({ method: 'GET', url: '/api/scenes', headers: { authorization: `Bearer ${pass(stranger, a.scene.id)}` } })
    expect(res.json().scenes).toEqual([])
  })

  it('the bound scene still works with normal role checks', async () => {
    const owner = await createUser()
    const a = await createScene(owner, 'A')
    const res = await app.inject({ method: 'GET', url: `/api/scenes/${a.scene.id}`, headers: { authorization: `Bearer ${pass(owner, a.scene.id)}` } })
    expect(res.statusCode).toBe(200)
  })

  it('upload tokens require scene.edit on the scene, for every caller', async () => {
    const owner = await createUser()
    const stranger = await createUser()
    const a = await createScene(owner, 'A')
    const denied = await app.inject({ method: 'POST', url: '/api/upload-tokens', headers: { authorization: `Bearer ${tokenFor(stranger)}` }, payload: { sceneId: a.scene.id } })
    expect(denied.statusCode).toBe(403)
    const ok = await app.inject({ method: 'POST', url: '/api/upload-tokens', headers: { authorization: `Bearer ${pass(owner, a.scene.id)}` }, payload: { sceneId: a.scene.id } })
    expect(ok.statusCode).toBe(201)
    const noScene = await app.inject({ method: 'POST', url: '/api/upload-tokens', headers: { authorization: `Bearer ${pass(owner, a.scene.id)}` }, payload: {} })
    expect(noScene.statusCode).toBe(403)
  })

  it('PUT /api/scenes/:sceneId refuses an activePresetId from another scene (account token and pass)', async () => {
    const owner = await createUser()
    const a = await createScene(owner, 'A')
    const b = await createScene(owner, 'B')
    for (const t of [tokenFor(owner), pass(owner, a.scene.id)]) {
      const h = { authorization: `Bearer ${t}` }
      const cross = await app.inject({ method: 'PUT', url: `/api/scenes/${a.scene.id}`, headers: h, payload: { activePresetId: b.preset.id } })
      expect(cross.statusCode).toBe(400)
      const junk = await app.inject({ method: 'PUT', url: `/api/scenes/${a.scene.id}`, headers: h, payload: { activePresetId: 'not-a-uuid' } })
      expect(junk.statusCode).toBe(400)
      const own = await app.inject({ method: 'PUT', url: `/api/scenes/${a.scene.id}`, headers: h, payload: { activePresetId: a.preset.id } })
      expect(own.statusCode).toBe(200)
    }
    const after = await app.inject({ method: 'GET', url: `/api/scenes/${a.scene.id}`, headers: { authorization: `Bearer ${tokenFor(owner)}` } })
    expect(after.json().scene.activePresetId).toBe(a.preset.id)
  })

  it('a pass reads analytics only through its own scene tenure, not a past tenure of another scene', async () => {
    const pastHost = await createUser()
    const newHost = await createUser()
    const a = await createScene(newHost, 'A')
    const b = await createScene(pastHost, 'B')
    const l = await createAnalyticsScene({ locationKey: 'gc:3,3', baseParcel: '3,3', parcels: ['3,3'] } as any)
    await createSetup(l.id, b.scene.id, { startedAt: new Date(Date.now() - 60 * 86400_000), endedAt: new Date(Date.now() - 30 * 86400_000) })
    await createSetup(l.id, a.scene.id)
    const t = pass(pastHost, a.scene.id, l.id)
    const res = await app.inject({ method: 'GET', url: `/api/analytics/locations/${l.id}/summary`, headers: { authorization: `Bearer ${t}` } })
    expect(res.statusCode).toBe(403)
    const list = await app.inject({ method: 'GET', url: '/api/analytics/locations', headers: { authorization: `Bearer ${t}` } })
    expect(list.json().scenes).toEqual([])
    // Account behaviour is unchanged: the past host still reads their ended tenure.
    const acct = await app.inject({ method: 'GET', url: `/api/analytics/locations/${l.id}/summary`, headers: { authorization: `Bearer ${tokenFor(pastHost)}` } })
    expect(acct.statusCode).toBe(200)
  })

  it('analytics locations list is filtered to the pass location', async () => {
    const owner = await createUser()
    const a = await createScene(owner, 'A')
    const b = await createScene(owner, 'B')
    const la = await createAnalyticsScene({ locationKey: 'gc:1,1', baseParcel: '1,1', parcels: ['1,1'] } as any)
    const lb = await createAnalyticsScene({ locationKey: 'gc:2,2', baseParcel: '2,2', parcels: ['2,2'] } as any)
    await createSetup(la.id, a.scene.id); await createSetup(lb.id, b.scene.id)
    const res = await app.inject({ method: 'GET', url: '/api/analytics/locations', headers: { authorization: `Bearer ${pass(owner, a.scene.id, la.id)}` } })
    expect(res.json().scenes.map((s: any) => s.id)).toEqual([la.id])
    const other = await app.inject({ method: 'GET', url: `/api/analytics/locations/${lb.id}/summary`, headers: { authorization: `Bearer ${pass(owner, a.scene.id, la.id)}` } })
    expect(other.statusCode).toBe(403)
    const own = await app.inject({ method: 'GET', url: `/api/analytics/locations/${la.id}/summary`, headers: { authorization: `Bearer ${pass(owner, a.scene.id, la.id)}` } })
    expect(own.statusCode).toBe(200)
  })
})
