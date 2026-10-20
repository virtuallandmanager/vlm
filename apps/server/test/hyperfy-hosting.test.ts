import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { db } from '../src/db/connection.js'
import { sceneDeployments } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { hyperfyHosting } from '../src/services/hyperfy/infrastructure.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, tokenFor, type TestUser } from './helpers/factories.js'

const HOSTING = {
  hyperfyInfraProvider: 'fly',
  flyApiToken: 'FlyV1 x',
  flyWorldsOrg: 'vlm-worlds',
  hyperfyImage: 'registry.fly.io/vlm-hyperfy-image:abc',
  hyperfyWorldsDatabaseUrl: 'postgres://a:b@h/db',
  hyperfyWorldsDbUrlTemplate: 'postgres://{user}:{password}@h/db',
  hyperfyAssetsS3Uri: 's3://k:s@acct.r2.cloudflarestorage.com/vlm-hyperfy',
  hyperfyAssetsBaseUrl: 'https://worlds-cdn.vlm.gg',
  hyperfyRouterDomain: 'worlds.vlm.gg',
  hyperfySecretKey: 'ab'.repeat(32),
}

// Hosted worlds run on Fly only, and only once every variable they need is set; there is no local stand-in.
describe('Hyperfy hosting availability', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let owner: TestUser
  let sceneId: string
  const saved: Record<string, unknown> = {}

  const configure = (values: Partial<Record<keyof typeof HOSTING, string | undefined>>) => {
    for (const [k, v] of Object.entries(values)) (config as any)[k] = v
  }

  beforeEach(async () => {
    await resetDb()
    app = await testApp()
    owner = await createUser()
    sceneId = (await createScene(owner, 'World')).scene.id
    for (const k of [...Object.keys(HOSTING), 'mode']) saved[k] = (config as any)[k]
    configure(Object.fromEntries(Object.keys(HOSTING).map((k) => [k, undefined])))
  })
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) (config as any)[k] = v
    await app.close()
  })

  const call = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${tokenFor(owner)}` }, payload: payload as any })

  it('is available only with provider fly and every hosting variable set', () => {
    expect(hyperfyHosting().available).toBe(false)
    configure(HOSTING)
    expect(hyperfyHosting()).toEqual({ available: true, provider: 'fly' })
    for (const k of Object.keys(HOSTING) as (keyof typeof HOSTING)[]) {
      configure({ ...HOSTING, [k]: undefined })
      expect(hyperfyHosting().available, k).toBe(false)
    }
    configure({ ...HOSTING, hyperfyInfraProvider: 'docker' })
    expect(hyperfyHosting().available).toBe(false)
  })

  it('is never available without Fly, in any mode', () => {
    for (const mode of ['single', 'scalable', 'cloud']) {
      ;(config as any).mode = mode
      expect(hyperfyHosting().available).toBe(false)
    }
  })

  it('POST /api/deploy no longer provisions Hyperfy worlds, and records nothing', async () => {
    configure(HOSTING)
    const res = await call('POST', '/api/deploy', { sceneId, platform: 'hyperfy', deploymentType: 'instance', target: { name: 'w' } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('hyperfy_use_worlds')
    expect(await db.select().from(sceneDeployments)).toHaveLength(0)
  })

  it('the old /api/deploy/hyperfy routes are gone', async () => {
    const res = await call('POST', '/api/deploy/hyperfy/provision', { sceneId, name: 'w' })
    expect(res.statusCode).toBe(404)
    const routes = ((app as any).registeredRoutes as Array<{ url: string }>).map((r) => r.url)
    expect(routes.filter((u) => u.startsWith('/api/deploy/hyperfy'))).toEqual([])
  })

  it('an old Hyperfy deployment is not redeployed, and nothing is created', async () => {
    configure(HOSTING)
    const [dep] = await db.insert(sceneDeployments).values({
      sceneId, platform: 'hyperfy', deploymentType: 'instance', status: 'failed', deployedBy: owner.id,
      target: { name: 'w', slug: 'w', instanceUrl: 'http://localhost:4000', provider: 'local', adminCode: 'secret' },
    }).returning()
    const res = await call('POST', `/api/deploy/${dep.id}/redeploy`)
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('hyperfy_use_worlds')
    expect(await db.select().from(sceneDeployments)).toHaveLength(1)
  })

  it('GET /api/deploy/platforms says whether Hyperfy can be deployed', async () => {
    expect((await call('GET', '/api/deploy/platforms')).json()).toEqual({ platforms: { decentraland: true, hyperfy: false } })
    configure(HOSTING)
    expect((await call('GET', '/api/deploy/platforms')).json().platforms.hyperfy).toBe(true)
  })
})
