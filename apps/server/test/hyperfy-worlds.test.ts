import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { HYPERFY_FEED } from 'vlm-shared'
import { db } from '../src/db/connection.js'
import { hyperfyWorlds } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { findWorldByKey } from '../src/hyperfy/worlds.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, tokenFor, type TestUser } from './helpers/factories.js'

describe('connect-your-own Hyperfy world', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let owner: TestUser
  let sceneId: string
  const mode = config.mode
  const unlocked = config.allFeaturesUnlocked
  const saved = { provider: process.env.HYPERFY_INFRA_PROVIDER, token: process.env.FLY_API_TOKEN }

  beforeEach(async () => {
    await resetDb()
    app = await testApp()
    owner = await createUser()
    sceneId = (await createScene(owner, 'World')).scene.id
  })
  afterEach(async () => {
    ;(config as any).mode = mode
    config.allFeaturesUnlocked = unlocked
    process.env.HYPERFY_INFRA_PROVIDER = saved.provider
    process.env.FLY_API_TOKEN = saved.token
    if (saved.provider === undefined) delete process.env.HYPERFY_INFRA_PROVIDER
    if (saved.token === undefined) delete process.env.FLY_API_TOKEN
    await app.close()
  })

  const call = (user: TestUser, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${tokenFor(user)}` }, payload: payload as any })
  const connect = (user = owner, name = 'My world') => call(user, 'POST', '/api/hyperfy/worlds', { sceneId, name })

  it('creating a world returns a vlmw_ key once and stores only its hash', async () => {
    const res = await connect()
    expect(res.statusCode).toBe(201)
    const { world, key } = res.json()
    expect(key).toMatch(/^vlmw_[0-9a-f]{64}$/)
    expect(world).toMatchObject({ sceneId, name: 'My world', kind: 'self', lastSeenAt: null })
    expect(JSON.stringify(world)).not.toContain(key)
    const [row] = await db.select().from(hyperfyWorlds)
    expect(row.keyHash).toBe(createHash('sha256').update(key).digest('hex'))
    expect(row.keyPrefix).toBe(key.slice(0, 12))
    expect(row.ownerId).toBe(owner.id)
    expect(JSON.stringify(row)).not.toContain(key)
  })

  it('findWorldByKey finds it, and fails after rotate-key', async () => {
    const { world, key } = (await connect()).json()
    expect((await findWorldByKey(key))?.id).toBe(world.id)
    expect(await findWorldByKey('vlmw_nope')).toBeNull()
    const rotated = await call(owner, 'POST', `/api/hyperfy/worlds/${world.id}/rotate-key`)
    expect(rotated.statusCode).toBe(200)
    const next = rotated.json().key
    expect(next).toMatch(new RegExp(`^${HYPERFY_FEED.keyPrefix}[0-9a-f]{64}$`))
    expect(next).not.toBe(key)
    expect(rotated.json().world.id).toBe(world.id)
    expect(await findWorldByKey(key)).toBeNull()
    expect((await findWorldByKey(next))?.id).toBe(world.id)
  })

  it('listing never includes the key', async () => {
    const { key } = (await connect()).json()
    const res = await call(owner, 'GET', `/api/hyperfy/worlds?sceneId=${sceneId}`)
    expect(res.statusCode).toBe(200)
    expect(res.json().worlds).toHaveLength(1)
    expect(res.body).not.toContain(key)
    expect(res.body).not.toContain('keyHash')
    expect(res.json().worlds[0].key).toBeUndefined()
  })

  it("another user can't list, rotate or delete it", async () => {
    const other = await createUser()
    const { world, key } = (await connect()).json()
    const list = await call(other, 'GET', `/api/hyperfy/worlds?sceneId=${sceneId}`)
    expect(list.statusCode).toBe(404)
    expect((await call(other, 'POST', `/api/hyperfy/worlds/${world.id}/rotate-key`)).statusCode).toBe(404)
    expect((await call(other, 'DELETE', `/api/hyperfy/worlds/${world.id}`)).statusCode).toBe(404)
    expect((await connect(other)).statusCode).toBe(404)
    expect((await findWorldByKey(key))?.id).toBe(world.id)
    expect((await call(owner, 'DELETE', `/api/hyperfy/worlds/${world.id}`)).json()).toEqual({ deleted: true })
    expect(await db.select().from(hyperfyWorlds).where(eq(hyperfyWorlds.id, world.id))).toHaveLength(0)
  })

  it('connecting works while Hyperfy hosting is unavailable (cloud mode)', async () => {
    ;(config as any).mode = 'cloud'
    delete process.env.HYPERFY_INFRA_PROVIDER
    delete process.env.FLY_API_TOKEN
    const res = await connect()
    expect(res.statusCode).toBe(201)
    expect(res.json().key).toMatch(/^vlmw_/)
  })

  it('free plan is refused by the deployment feature gate', async () => {
    config.allFeaturesUnlocked = false
    const res = await connect()
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ error: 'upgrade_required', feature: 'deployment' })
    expect(await db.select().from(hyperfyWorlds)).toHaveLength(0)
  })

  it('validates the body', async () => {
    expect((await call(owner, 'POST', '/api/hyperfy/worlds', { sceneId, name: '  ' })).statusCode).toBe(400)
    expect((await call(owner, 'POST', '/api/hyperfy/worlds', { sceneId: 'nope', name: 'x' })).statusCode).toBe(404)
    expect((await call(owner, 'GET', '/api/hyperfy/worlds')).statusCode).toBe(400)
  })

  it('app.hyp downloads the built app', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/hyperfy/app.hyp' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('application/octet-stream')
    expect(res.headers['content-disposition']).toBe('attachment; filename="vlm.hyp"')
    const body = res.rawPayload
    const headerLen = body.readUInt32LE(0)
    expect(headerLen).toBeGreaterThan(0)
    expect(headerLen).toBeLessThan(body.length)
    const header = JSON.parse(body.subarray(4, 4 + headerLen).toString('utf8'))
    expect(header.blueprint).toBeTruthy()
    expect(Array.isArray(header.assets)).toBe(true)
  })
})
