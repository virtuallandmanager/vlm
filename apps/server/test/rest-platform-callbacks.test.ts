import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../src/integrations/platform-hooks.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/integrations/platform-hooks.js')>()),
  dispatchPlatformCallbacks: vi.fn(async () => {}),
}))

import { db } from '../src/db/connection.js'
import { scenePresets } from '../src/db/schema.js'
import { dispatchPlatformCallbacks } from '../src/integrations/platform-hooks.js'
import { resetDb } from './helpers/db.js'
import { createUser, createScene, tokenFor, testApp } from './helpers/factories.js'

const dispatch = vi.mocked(dispatchPlatformCallbacks)
const until = async (n: number) => {
  for (let i = 0; i < 100 && dispatch.mock.calls.length < n; i++) await new Promise((r) => setTimeout(r, 10))
}

describe('REST element/instance writes dispatch platform callbacks', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => {
    await resetDb()
    app = await testApp()
    dispatch.mockClear()
  })
  afterEach(() => app.close())

  it('one config_update per write with the compact element config; delete flagged', async () => {
    const host = await createUser()
    const { scene, preset } = await createScene(host)
    const headers = { authorization: `Bearer ${tokenFor(host)}` }
    const created = await app.inject({
      method: 'POST', url: `/api/presets/${preset.id}/elements`, headers,
      payload: { type: 'image', name: 'Poster', properties: { textureSrc: 'https://cdn.vlm.gg/u1/a.png' } },
    })
    const elementId = created.json().element.id
    await until(1)
    expect(dispatch).toHaveBeenCalledTimes(1)
    const [sceneId, payload] = dispatch.mock.calls[0] as [string, Record<string, unknown>]
    expect(sceneId).toBe(scene.id)
    expect(payload).toMatchObject({ action: 'config_update', elementId, element: 'image', name: 'Poster', textureSrc: 'https://cdn.vlm.gg/u1/a.png' })
    expect(payload).not.toHaveProperty('instances')
    expect(payload).not.toHaveProperty('sk')

    const inst = await app.inject({ method: 'POST', url: `/api/elements/${elementId}/instances`, headers, payload: { position: { x: 1, y: 2, z: 3 } } })
    await until(2)
    await app.inject({ method: 'PUT', url: `/api/instances/${inst.json().instance.id}`, headers, payload: { position: { x: 4, y: 2, z: 3 } } })
    await until(3)
    await app.inject({ method: 'PUT', url: `/api/elements/${elementId}`, headers, payload: { enabled: false } })
    await until(4)
    expect((dispatch.mock.calls[3] as any)[1]).toMatchObject({ action: 'config_update', elementId, enabled: false })
    await app.inject({ method: 'DELETE', url: `/api/elements/${elementId}`, headers })
    await until(5)
    expect(dispatch).toHaveBeenCalledTimes(5)
    expect((dispatch.mock.calls[4] as any)[1]).toEqual({ action: 'config_update', elementId, element: 'image', deleted: true })
  })

  it('edits to a non-active preset are not dispatched, and dispatcher failures do not fail the write', async () => {
    const host = await createUser()
    const { scene } = await createScene(host)
    const [other] = await db.insert(scenePresets).values({ sceneId: scene.id, name: 'Other' }).returning()
    const res = await app.inject({
      method: 'POST', url: `/api/presets/${other.id}/elements`, headers: { authorization: `Bearer ${tokenFor(host)}` },
      payload: { type: 'image', name: 'Hidden' },
    })
    expect(res.statusCode).toBe(201)
    await new Promise((r) => setTimeout(r, 100))
    expect(dispatch).not.toHaveBeenCalled()

    dispatch.mockRejectedValueOnce(new Error('boom'))
    const { preset } = await createScene(host)
    const ok = await app.inject({
      method: 'POST', url: `/api/presets/${preset.id}/elements`, headers: { authorization: `Bearer ${tokenFor(host)}` },
      payload: { type: 'image', name: 'Shown' },
    })
    expect(ok.statusCode).toBe(201)
  })
})
