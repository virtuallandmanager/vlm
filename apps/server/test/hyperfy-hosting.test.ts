import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { db } from '../src/db/connection.js'
import { sceneDeployments } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { hyperfyHosting } from '../src/services/hyperfy/infrastructure.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, tokenFor, type TestUser } from './helpers/factories.js'

// With no Hyperfy hosting configured, the dev stub used to report a fake localhost world as deployed.
describe('Hyperfy hosting availability', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let owner: TestUser
  let sceneId: string
  const mode = config.mode
  const saved = { provider: process.env.HYPERFY_INFRA_PROVIDER, token: process.env.FLY_API_TOKEN }

  beforeEach(async () => {
    await resetDb()
    app = await testApp()
    owner = await createUser()
    sceneId = (await createScene(owner, 'World')).scene.id
    delete process.env.HYPERFY_INFRA_PROVIDER
    delete process.env.FLY_API_TOKEN
  })
  afterEach(async () => {
    ;(config as any).mode = mode
    process.env.HYPERFY_INFRA_PROVIDER = saved.provider
    process.env.FLY_API_TOKEN = saved.token
    if (saved.provider === undefined) delete process.env.HYPERFY_INFRA_PROVIDER
    if (saved.token === undefined) delete process.env.FLY_API_TOKEN
    await app.close()
  })

  const call = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${tokenFor(owner)}` }, payload: payload as any })

  it('the local stub is never available in cloud mode', () => {
    ;(config as any).mode = 'cloud'
    expect(hyperfyHosting()).toEqual({ available: false, provider: 'local' })
  })

  it('fly is available only with an API token', () => {
    ;(config as any).mode = 'cloud'
    process.env.HYPERFY_INFRA_PROVIDER = 'fly'
    expect(hyperfyHosting().available).toBe(false)
    process.env.FLY_API_TOKEN = 'x'
    expect(hyperfyHosting()).toEqual({ available: true, provider: 'fly' })
  })

  it('the local stub stays available for single-mode development', () => {
    ;(config as any).mode = 'single'
    expect(hyperfyHosting().available).toBe(true)
  })

  it('in cloud mode with no hosting, both provision routes refuse with 503 and record nothing', async () => {
    ;(config as any).mode = 'cloud'
    const viaDeploy = await call('POST', '/api/deploy', { sceneId, platform: 'hyperfy', deploymentType: 'instance', target: { name: 'w' } })
    expect(viaDeploy.statusCode).toBe(503)
    expect(viaDeploy.json().error).toBe('hyperfy_hosting_unavailable')
    const viaProvision = await call('POST', '/api/deploy/hyperfy/provision', { sceneId, name: 'w' })
    expect(viaProvision.statusCode).toBe(503)
    expect(await db.select().from(sceneDeployments)).toHaveLength(0)
  })

  it('GET /api/deploy/platforms says whether Hyperfy can be deployed', async () => {
    ;(config as any).mode = 'cloud'
    expect((await call('GET', '/api/deploy/platforms')).json()).toEqual({ platforms: { decentraland: true, hyperfy: false } })
    ;(config as any).mode = 'single'
    expect((await call('GET', '/api/deploy/platforms')).json().platforms.hyperfy).toBe(true)
  })
})
