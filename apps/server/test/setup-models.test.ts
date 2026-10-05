import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { db } from '../src/db/connection.js'
import { mediaAssets } from '../src/db/schema.js'
import { setSetupLimiter } from '../src/routes/setup.js'
import { TokenBucketLimiter } from '../src/analytics/limiter.js'
import { resetDb } from './helpers/db.js'
import { createUser, createScene, createElement, testApp } from './helpers/factories.js'
import { createAnalyticsScene } from './helpers/analytics.js'
import { createSetup } from './helpers/setups.js'

describe('GET /api/setup/models', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => {
    await resetDb()
    app = await testApp()
    setSetupLimiter(new TokenBucketLimiter())
  })
  afterEach(async () => {
    await app.close()
  })
  const get = (location: string) => app.inject({ method: 'GET', url: `/api/setup/models?location=${encodeURIComponent(location)}` })

  async function setup(locationKey: string, endedAt?: Date) {
    const owner = await createUser()
    const { scene, preset } = await createScene(owner)
    const a = await createAnalyticsScene({ locationKey })
    await createSetup(a.id, scene.id, { endedAt: endedAt ?? null })
    return { owner, scene, preset }
  }

  it('lists only hosted glb models of the active preset', async () => {
    const { owner, scene, preset } = await setup('gc:5,6')
    await db.insert(mediaAssets).values({ ownerId: owner.id, filename: 'aa.glb', contentType: 'model/gltf-binary', sizeBytes: 1234, storageKey: 'u/aa.glb', publicUrl: 'https://cdn.vlm.gg/u/aa.glb' })
    const m = await createElement(preset.id, { type: 'model', name: 'Hosted', properties: { modelSrc: 'https://cdn.vlm.gg/u/aa.glb' } })
    await createElement(preset.id, { type: 'model', name: 'Local', properties: { modelSrc: 'models/local.glb' } })
    await createElement(preset.id, { type: 'image', name: 'Pic', properties: { imageSrc: 'https://cdn.vlm.gg/u/p.png' } })
    const res = await get('gc:5,6')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      sceneId: scene.id,
      models: [{ elementId: m.id, name: 'Hosted', url: 'https://cdn.vlm.gg/u/aa.glb', file: 'models/vlm/aa.glb', sizeBytes: 1234 }],
    })
  })

  it('sizeBytes is null when no media row matches', async () => {
    const { preset } = await setup('gc:5,6')
    await createElement(preset.id, { type: 'model', properties: { modelSrc: 'https://elsewhere.example/x.glb' } })
    expect((await get('gc:5,6')).json().models[0].sizeBytes).toBeNull()
  })

  it('resolves worlds case-insensitively', async () => {
    await setup('world:venue.dcl.eth')
    expect((await get('world:Venue.DCL.eth')).statusCode).toBe(200)
  })

  it('404 for an ended setup', async () => {
    await setup('gc:5,6', new Date())
    const res = await get('gc:5,6')
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'not_set_up' })
  })

  it('404 for an unknown location', async () => {
    expect((await get('gc:9,9')).statusCode).toBe(404)
  })

  it('400 for a bad or preview location', async () => {
    expect((await get('nope')).statusCode).toBe(400)
    expect((await get('preview:abc')).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: '/api/setup/models' })).statusCode).toBe(400)
  })

  it('429 when the per-IP limit is exceeded', async () => {
    let last = 200
    for (let i = 0; i < 500 && last !== 429; i++) last = (await get('gc:9,9')).statusCode
    expect(last).toBe(429)
  })
})

describe('GET /api/setup/scene', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => {
    await resetDb()
    app = await testApp()
    setSetupLimiter(new TokenBucketLimiter())
  })
  afterEach(async () => {
    await app.close()
  })
  const get = (location: string) => app.inject({ method: 'GET', url: `/api/setup/scene?location=${encodeURIComponent(location)}` })

  async function setup(locationKey: string, endedAt?: Date) {
    const owner = await createUser()
    const { scene } = await createScene(owner)
    const a = await createAnalyticsScene({ locationKey })
    await createSetup(a.id, scene.id, { endedAt: endedAt ?? null })
    return scene
  }

  it('returns the sceneId of the active setup', async () => {
    const scene = await setup('gc:5,6')
    const res = await get('gc:5,6')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ sceneId: scene.id })
  })

  it('resolves worlds case-insensitively', async () => {
    const scene = await setup('world:venue.dcl.eth')
    expect((await get('world:Venue.DCL.eth')).json()).toEqual({ sceneId: scene.id })
  })

  it('404 not_set_up for an unknown location or ended setup', async () => {
    await setup('gc:5,6', new Date())
    for (const loc of ['gc:5,6', 'gc:9,9']) {
      const res = await get(loc)
      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ error: 'not_set_up' })
    }
  })

  it('400 for a bad or preview location', async () => {
    expect((await get('nope')).statusCode).toBe(400)
    expect((await get('preview:abc')).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: '/api/setup/scene' })).statusCode).toBe(400)
  })

  it('429 when the per-IP limit is exceeded', async () => {
    let last = 200
    for (let i = 0; i < 500 && last !== 429; i++) last = (await get('gc:9,9')).statusCode
    expect(last).toBe(429)
  })
})
