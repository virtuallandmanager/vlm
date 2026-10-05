import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { db } from '../src/db/connection.js'
import { sceneCollaborators } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, createElement, createInstance, tokenFor } from './helpers/factories.js'

describe('scene routes enforce collaborator roles', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => {
    await resetDb()
    app = await testApp()
  })
  afterEach(() => app.close())

  async function setup() {
    const owner = await createUser()
    const editor = await createUser()
    const viewer = await createUser()
    const stranger = await createUser()
    const { scene, preset } = await createScene(owner)
    const element = await createElement(preset.id)
    const instance = await createInstance(element.id)
    await db.insert(sceneCollaborators).values([
      { sceneId: scene.id, userId: editor.id, role: 'editor' },
      { sceneId: scene.id, userId: viewer.id, role: 'viewer' },
    ])
    return { owner, editor, viewer, stranger, scene, preset, element, instance }
  }

  const as = (u: any) => ({ authorization: `Bearer ${tokenFor(u)}` })

  it('editor can update an element and instance; viewer and stranger cannot', async () => {
    const s = await setup()
    const put = (u: any) =>
      app.inject({ method: 'PUT', url: `/api/elements/${s.element.id}`, headers: as(u), payload: { properties: { liveSrc: 'x' } } })
    expect((await put(s.editor)).statusCode).toBe(200)
    expect((await put(s.viewer)).statusCode).toBe(403)
    expect((await put(s.stranger)).statusCode).toBe(403)
    const putInst = await app.inject({
      method: 'PUT',
      url: `/api/instances/${s.instance.id}`,
      headers: as(s.editor),
      payload: { position: { x: 2, y: 2, z: 2 } },
    })
    expect(putInst.statusCode).toBe(200)
  })

  it('editor can create presets and elements', async () => {
    const s = await setup()
    const res = await app.inject({
      method: 'POST',
      url: `/api/presets/${s.preset.id}/elements`,
      headers: as(s.editor),
      payload: { type: 'image', name: 'Poster' },
    })
    expect(res.statusCode).toBe(201)
  })

  it('editor cannot delete the scene or manage collaborators', async () => {
    const s = await setup()
    expect((await app.inject({ method: 'DELETE', url: `/api/scenes/${s.scene.id}`, headers: as(s.editor) })).statusCode).toBe(403)
    const add = await app.inject({
      method: 'POST',
      url: `/api/scenes/${s.scene.id}/collaborators`,
      headers: as(s.editor),
      payload: { email: s.stranger.email, role: 'viewer' },
    })
    expect(add.statusCode).toBe(403)
  })

  it('viewer can read the scene; stranger cannot', async () => {
    const s = await setup()
    expect((await app.inject({ method: 'GET', url: `/api/scenes/${s.scene.id}`, headers: as(s.viewer) })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: `/api/scenes/${s.scene.id}`, headers: as(s.stranger) })).statusCode).toBe(403)
  })

  it('GET /api/scenes lists owned and collaborated scenes with relationship', async () => {
    const s = await setup()
    const res = await app.inject({ method: 'GET', url: '/api/scenes', headers: as(s.editor) })
    expect(res.json().scenes).toEqual([expect.objectContaining({ id: s.scene.id, relationship: 'editor' })])
    const own = await app.inject({ method: 'GET', url: '/api/scenes', headers: as(s.owner) })
    expect(own.json().scenes[0].relationship).toBe('owner')
  })

  it('GET /api/scenes returns nothing for an unverified token', async () => {
    const s = await setup()
    for (const u of [s.owner, s.editor]) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/scenes',
        headers: { authorization: `Bearer ${tokenFor(u, { verified: false })}` },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json().scenes).toEqual([])
    }
  })

  it('owner keeps full access', async () => {
    const s = await setup()
    expect((await app.inject({ method: 'DELETE', url: `/api/scenes/${s.scene.id}`, headers: as(s.owner) })).statusCode).toBe(204)
  })
})
