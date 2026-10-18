import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { sceneCollaborators, sceneElementInstances } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { createUser, createScene, createElement, createInstance, tokenFor } from './helpers/factories.js'
import { startGameServer, joinScene, serverRoom } from './helpers/game-server.js'

const draft = (sk: string, x = 5) => ({
  element: 'video',
  sk,
  position: { x, y: 2, z: 3 },
  rotation: { x: 0, y: 90, z: 0 },
  scale: { x: 1, y: 1, z: 1 },
})
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms))
const count = (c: { inbox: { type: string }[] }, type: string) => c.inbox.filter((m) => m.type === type).length

describe('transform draft relay', () => {
  let gs: Awaited<ReturnType<typeof startGameServer>>
  beforeEach(async () => {
    await resetDb()
    gs = await startGameServer()
  })
  afterEach(() => gs.stop())

  async function setup() {
    const ownerU = await createUser({ name: 'Olivia' })
    const { scene, preset } = await createScene(ownerU)
    const screen = await createElement(preset.id)
    const inst = await createInstance(screen.id)
    const editorU = await createUser()
    const viewerU = await createUser()
    await db.insert(sceneCollaborators).values([
      { sceneId: scene.id, userId: editorU.id, role: 'editor' },
      { sceneId: scene.id, userId: viewerU.id, role: 'viewer' },
    ])
    const owner = await joinScene(gs.url, scene.id, tokenFor(ownerU))
    const editor = await joinScene(gs.url, scene.id, tokenFor(editorU))
    const viewer = await joinScene(gs.url, scene.id, tokenFor(viewerU))
    const visitor = await joinScene(gs.url, scene.id)
    for (const c of [owner, editor, viewer, visitor]) await c.waitFor('scene_preset_update') // init
    const srv = serverRoom(owner.room.roomId)
    return { ownerU, editorU, scene, preset, screen, inst, owner, editor, viewer, visitor }
  }
  const row = async (id: string) => (await db.query.sceneElementInstances.findFirst({ where: eq(sceneElementInstances.id, id) }))!

  it('relays an editor draft to other editors only, with the holder name', async () => {
    const s = await setup()
    s.owner.room.send('transform_draft', draft(s.inst.id))
    const got = await s.editor.waitFor('transform_draft')
    expect(got).toMatchObject({ sk: s.inst.id, holderName: 'Olivia', holderSessionId: s.owner.room.sessionId, position: { x: 5, y: 2, z: 3 } })
    await s.visitor.expectNone('transform_draft', 200)
    await s.viewer.expectNone('transform_draft', 200)
    await s.owner.expectNone('transform_draft', 200)
  })

  it('uses the account display name from the database, not a client-supplied one', async () => {
    const s = await setup()
    const srv = serverRoom(s.owner.room.roomId)
    expect(srv.clientMeta.get(s.owner.room.sessionId).displayName).toBe('Olivia')
  })

  it('falls back to "Another editor" when no name is available', async () => {
    const s = await setup()
    serverRoom(s.owner.room.roomId).clientMeta.get(s.owner.room.sessionId).displayName = 'Guest'
    s.owner.room.send('transform_draft', draft(s.inst.id))
    expect((await s.editor.waitFor('transform_draft')).holderName).toBe('Another editor')
  })

  it('holder can end after losing scene.edit', async () => {
    const s = await setup()
    s.editor.room.send('transform_draft', draft(s.inst.id))
    await s.owner.waitFor('transform_draft')
    await db.delete(sceneCollaborators).where(eq(sceneCollaborators.userId, s.editorU.id))
    serverRoom(s.owner.room.roomId).accessCache.clear()
    s.editor.room.send('transform_end', { sk: s.inst.id, saved: false })
    expect(await s.owner.waitFor('transform_draft_end')).toEqual({ sk: s.inst.id, saved: false })
    s.owner.room.send('transform_draft', draft(s.inst.id))
    await settle()
    expect(count(s.owner, 'transform_held')).toBe(0)
  })

  it('holder can end after the instance is deleted', async () => {
    const s = await setup()
    s.owner.room.send('transform_draft', draft(s.inst.id))
    await s.editor.waitFor('transform_draft')
    await db.delete(sceneElementInstances).where(eq(sceneElementInstances.id, s.inst.id))
    s.owner.room.send('transform_end', { sk: s.inst.id, saved: false })
    expect(await s.editor.waitFor('transform_draft_end')).toEqual({ sk: s.inst.id, saved: false })
    expect(serverRoom(s.owner.room.roomId).draftHolders.has(s.inst.id)).toBe(false)
  })

  it('rejects malformed drafts and relays nothing', async () => {
    const s = await setup()
    s.owner.room.send('transform_draft', { ...draft(s.inst.id), position: { x: NaN, y: 0, z: 0 } })
    expect((await s.owner.waitFor('vlm_error')).code).toBe('bad_request')
    const { scale, ...noScale } = draft(s.inst.id)
    s.owner.room.send('transform_draft', noScale)
    expect((await s.owner.waitFor('vlm_error')).code).toBe('bad_request')
    s.owner.room.send('transform_draft', { ...draft(s.inst.id), element: 'widget' })
    expect((await s.owner.waitFor('vlm_error')).code).toBe('bad_request')
    await s.editor.expectNone('transform_draft', 200)
  })

  it('rejects a viewer collaborator and relays nothing', async () => {
    const s = await setup()
    s.viewer.room.send('transform_draft', draft(s.inst.id))
    expect((await s.viewer.waitFor('vlm_error')).code).toBe('forbidden')
    await s.owner.expectNone('transform_draft', 200)
    await s.editor.expectNone('transform_draft', 200)
  })

  it('rejects an sk from another scene', async () => {
    const s = await setup()
    const other = await createScene(await createUser(), 'Other')
    const otherInst = await createInstance((await createElement(other.preset.id)).id)
    s.owner.room.send('transform_draft', draft(otherInst.id))
    expect((await s.owner.waitFor('vlm_error')).code).toBe('not_found')
    await s.editor.expectNone('transform_draft', 200)
  })

  it('tells a second editor who holds the instance and relays nothing to the holder', async () => {
    const s = await setup()
    s.owner.room.send('transform_draft', draft(s.inst.id))
    await s.editor.waitFor('transform_draft')
    s.editor.room.send('transform_draft', draft(s.inst.id, 9))
    expect(await s.editor.waitFor('transform_held')).toEqual({ sk: s.inst.id, holderName: 'Olivia' })
    await s.owner.expectNone('transform_draft', 200)
    await s.owner.expectNone('transform_held', 10)
  })

  it('drops more than 20 drafts per second silently', async () => {
    const s = await setup()
    for (let i = 0; i < 30; i++) s.owner.room.send('transform_draft', draft(s.inst.id, i))
    await settle(600)
    expect(count(s.editor, 'transform_draft')).toBeLessThanOrEqual(20)
    expect(count(s.editor, 'transform_draft')).toBeGreaterThan(0)
    expect(count(s.owner, 'vlm_error')).toBe(0)
  })

  it('releases the hold when the holder leaves', async () => {
    const s = await setup()
    s.owner.room.send('transform_draft', draft(s.inst.id))
    await s.editor.waitFor('transform_draft')
    await s.owner.room.leave()
    expect(await s.editor.waitFor('transform_draft_end')).toEqual({ sk: s.inst.id, saved: false })
    s.editor.room.send('transform_draft', draft(s.inst.id, 7))
    await settle()
    expect(count(s.editor, 'transform_held')).toBe(0)
  })

  it('save: instance update then transform_end { saved: true }', async () => {
    const s = await setup()
    s.owner.room.send('transform_draft', draft(s.inst.id))
    await s.editor.waitFor('transform_draft')
    s.owner.room.send('scene_preset_update', {
      action: 'update',
      element: 'video',
      instance: true,
      instanceData: { sk: s.inst.id, position: { x: 5, y: 2, z: 3 }, rotation: { x: 0, y: 90, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
    })
    const upd = await s.visitor.waitFor('scene_preset_update')
    expect(upd.instanceData.position).toEqual({ x: 5, y: 2, z: 3 })
    s.owner.room.send('transform_end', { sk: s.inst.id, saved: true })
    expect(await s.editor.waitFor('transform_draft_end')).toEqual({ sk: s.inst.id, saved: true })
    expect((await row(s.inst.id)).position).toEqual({ x: 5, y: 2, z: 3 })
  })

  it('ignores transform_end from a non-holder; holder end with saved false releases', async () => {
    const s = await setup()
    s.owner.room.send('transform_draft', draft(s.inst.id))
    await s.editor.waitFor('transform_draft')
    s.editor.room.send('transform_end', { sk: s.inst.id, saved: true })
    await s.owner.expectNone('transform_draft_end', 200)
    s.owner.room.send('transform_end', { sk: s.inst.id, saved: false })
    expect(await s.editor.waitFor('transform_draft_end')).toEqual({ sk: s.inst.id, saved: false })
  })

  it('never persists drafts', async () => {
    const s = await setup()
    const before = await row(s.inst.id)
    for (let i = 0; i < 5; i++) s.owner.room.send('transform_draft', draft(s.inst.id, 40 + i))
    await settle(500)
    expect(await row(s.inst.id)).toEqual(before)
  })
})
