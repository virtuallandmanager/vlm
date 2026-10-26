import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { arDevices, sceneCollaborators } from '../src/db/schema.js'
import { db } from '../src/db/connection.js'
import { config } from '../src/config.js'
import { issueArPass } from '../src/auth/scene-pass.js'
import { holderOf } from '../src/ws/draft-holds.js'
import { runDraftSweep } from '../src/ws/VirviSceneRoom.js'
import { setArDraftClock } from '../src/routes/ar-drafts.js'
import { resetDb } from './helpers/db.js'
import { createElement, createInstance, createScene, createUser, testApp, tokenFor, type TestUser } from './helpers/factories.js'
import { startGameServer, joinScene } from './helpers/game-server.js'

const SECRET = 'draft-headset-secret'
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const bearer = (t: string) => ({ authorization: `Bearer ${t}` })
const draft = (sk: string, x = 5) => ({
  element: 'video',
  sk,
  position: { x, y: 2, z: 3 },
  rotation: { x: 0, y: 90, z: 0 },
  scale: { x: 1, y: 1, z: 1 },
})
const count = (c: { inbox: { type: string }[] }, type: string) => c.inbox.filter((m) => m.type === type).length
const MIN = 60_000

describe('AR draft relay', () => {
  let gs: Awaited<ReturnType<typeof startGameServer>>
  let app: Awaited<ReturnType<typeof testApp>>
  const prev = { mode: config.mode, useRedisPresence: config.useRedisPresence, redisUrl: config.redisUrl }
  beforeEach(async () => {
    await resetDb()
    gs = await startGameServer()
    app = await testApp()
  })
  afterEach(async () => {
    Object.assign(config, prev)
    setArDraftClock(null)
    await app.close()
    await gs.stop()
  })

  async function pairedHeadset(owner: TestUser, sceneId: string, kind: 'personal' | 'shared' = 'personal') {
    const [device] = await db
      .insert(arDevices)
      .values({ userId: owner.id, secretHash: sha256(SECRET), kind, status: 'claimed', codeExpiresAt: new Date(), expiresAt: new Date(Date.now() + 3600_000) })
      .returning()
    const { pass } = issueArPass(app, owner, owner.wallet ?? null, { deviceId: device.id, sceneId })
    return { deviceId: device.id, pass }
  }

  async function setup(opts: { join?: boolean; kind?: 'personal' | 'shared' } = {}) {
    const ownerU = await createUser({ name: 'Olivia' })
    const { scene, preset } = await createScene(ownerU)
    const screen = await createElement(preset.id)
    const inst = await createInstance(screen.id)
    const inst2 = await createInstance(screen.id)
    const editorU = await createUser({ name: 'Eddie' })
    const viewerU = await createUser()
    await db.insert(sceneCollaborators).values([
      { sceneId: scene.id, userId: editorU.id, role: 'editor' },
      { sceneId: scene.id, userId: viewerU.id, role: 'viewer' },
    ])
    const headset = await pairedHeadset(ownerU, scene.id, opts.kind)
    const join = async () => {
      const editor = await joinScene(gs.url, scene.id, tokenFor(editorU))
      const viewer = await joinScene(gs.url, scene.id, tokenFor(viewerU))
      for (const c of [editor, viewer]) await c.waitFor('scene_preset_update') // init
      return { editor, viewer }
    }
    const clients = opts.join === false ? null : await join()
    const post = (body: unknown, token = headset.pass) => app.inject({ method: 'POST', url: '/api/ar/drafts', headers: bearer(token), payload: body as any })
    const end = (body: unknown, token = headset.pass) => app.inject({ method: 'POST', url: '/api/ar/drafts/end', headers: bearer(token), payload: body as any })
    return { ownerU, editorU, scene, preset, inst, inst2, headset, join, post, end, editor: clients?.editor!, viewer: clients?.viewer! }
  }

  it('a headset draft reaches a Decentraland editor', async () => {
    const s = await setup()
    const res = await s.post(draft(s.inst.id, 7))
    expect(res.statusCode).toBe(204)
    const got = await s.editor.waitFor('transform_draft')
    expect(got).toMatchObject({ element: 'video', sk: s.inst.id, position: { x: 7, y: 2, z: 3 }, rotation: { x: 0, y: 90, z: 0 }, scale: { x: 1, y: 1, z: 1 } })
    expect(got.holderName).toBe('Olivia (headset)')
    expect(got.holderName.endsWith('(headset)')).toBe(true)
  })

  it("a viewer doesn't receive it", async () => {
    const s = await setup()
    expect((await s.post(draft(s.inst.id))).statusCode).toBe(204)
    await s.editor.waitFor('transform_draft')
    await s.viewer.expectNone('transform_draft', 200)
  })

  it('a held item is refused', async () => {
    const s = await setup()
    s.editor.room.send('transform_draft', draft(s.inst.id, 1))
    // The editor's hold is in the registry once the room has taken it.
    for (let i = 0; i < 100 && !holderOf(s.scene.id, s.inst.id); i++) await new Promise((r) => setTimeout(r, 20))
    const res = await s.post(draft(s.inst.id, 9))
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'held', holderName: 'Eddie' })
    expect(holderOf(s.scene.id, s.inst.id)?.key).toBe(`room:${s.editor.room.sessionId}`)
    await s.editor.expectNone('transform_draft', 200)
  })

  it("the headset's hold blocks the editor", async () => {
    const s = await setup()
    expect((await s.post(draft(s.inst.id))).statusCode).toBe(204)
    await s.editor.waitFor('transform_draft')
    s.editor.room.send('transform_draft', draft(s.inst.id, 2))
    expect(await s.editor.waitFor('transform_held')).toEqual({ sk: s.inst.id, holderName: 'Olivia (headset)' })
  })

  it('ending the draft relays transform_draft_end', async () => {
    const s = await setup()
    expect((await s.post(draft(s.inst.id))).statusCode).toBe(204)
    await s.editor.waitFor('transform_draft')
    expect((await s.end({ sk: s.inst.id, saved: true })).statusCode).toBe(204)
    expect(await s.editor.waitFor('transform_draft_end')).toEqual({ sk: s.inst.id, saved: true })
    expect(holderOf(s.scene.id, s.inst.id)).toBeUndefined()
    // Ending what the headset doesn't hold changes nothing.
    expect((await s.end({ sk: s.inst2.id, saved: false })).statusCode).toBe(204)
    await s.editor.expectNone('transform_draft_end', 200)
  })

  it('the hold lapses after 10 minutes', async () => {
    const s = await setup()
    expect((await s.post(draft(s.inst.id))).statusCode).toBe(204)
    await s.editor.waitFor('transform_draft')
    runDraftSweep(Date.now() + 9 * MIN)
    await s.editor.expectNone('transform_draft_end', 200)
    runDraftSweep(Date.now() + 10 * MIN + 1000)
    expect(await s.editor.waitFor('transform_draft_end')).toEqual({ sk: s.inst.id, saved: false })
    expect(holderOf(s.scene.id, s.inst.id)).toBeUndefined()
    s.editor.room.send('transform_draft', draft(s.inst.id, 3))
    await s.editor.expectNone('transform_held', 300)
  })

  it('ending a shared session ends its drafts', async () => {
    const s = await setup({ kind: 'shared' })
    expect((await s.post(draft(s.inst.id))).statusCode).toBe(204)
    expect((await s.post(draft(s.inst2.id))).statusCode).toBe(204)
    await s.editor.waitFor('transform_draft')
    await s.editor.waitFor('transform_draft')
    const res = await app.inject({ method: 'POST', url: `/api/ar/devices/${s.headset.deviceId}/end`, payload: { secret: SECRET } })
    expect(res.statusCode).toBe(204)
    const ends = [await s.editor.waitFor('transform_draft_end'), await s.editor.waitFor('transform_draft_end')]
    expect(ends.sort((a, b) => a.sk.localeCompare(b.sk))).toEqual(
      [s.inst.id, s.inst2.id].sort().map((sk) => ({ sk, saved: false })),
    )
    expect(holderOf(s.scene.id, s.inst.id)).toBeUndefined()
    expect(holderOf(s.scene.id, s.inst2.id)).toBeUndefined()
  })

  it("a draft still in flight when its session ends doesn't take a hold", async () => {
    const s = await setup({ kind: 'shared' })
    const real = db.query.users.findFirst.bind(db.query.users)
    let slowed = false
    const spy = vi.spyOn(db.query.users, 'findFirst').mockImplementation(((...args: any[]) => {
      if (slowed) return (real as any)(...args)
      slowed = true // only the draft's holder-name lookup is slowed
      return new Promise((r) => setTimeout(r, 300)).then(() => (real as any)(...args))
    }) as any)
    try {
      const pending = s.post(draft(s.inst.id))
      await new Promise((r) => setTimeout(r, 100))
      expect(slowed).toBe(true)
      const ended = await app.inject({ method: 'POST', url: `/api/ar/devices/${s.headset.deviceId}/end`, payload: { secret: SECRET } })
      expect(ended.statusCode).toBe(204)
      expect((await pending).statusCode).toBe(204)
      expect(holderOf(s.scene.id, s.inst.id)).toBeUndefined()
      await s.editor.expectNone('transform_draft', 200)
    } finally {
      spy.mockRestore()
    }
  })

  it('revoking the headset from the website ends its drafts', async () => {
    const s = await setup()
    expect((await s.post(draft(s.inst.id))).statusCode).toBe(204)
    await s.editor.waitFor('transform_draft')
    const res = await app.inject({ method: 'DELETE', url: `/api/ar/devices/${s.headset.deviceId}`, headers: bearer(tokenFor(s.ownerU)) })
    expect(res.statusCode).toBeLessThan(300)
    expect(await s.editor.waitFor('transform_draft_end')).toEqual({ sk: s.inst.id, saved: false })
  })

  it('an editor taking over a lapsed headset hold relays its end to the other editors only', async () => {
    const s = await setup()
    const other = await joinScene(gs.url, s.scene.id, tokenFor(s.ownerU))
    await other.waitFor('scene_preset_update')
    expect((await s.post(draft(s.inst.id))).statusCode).toBe(204)
    await s.editor.waitFor('transform_draft')
    await other.waitFor('transform_draft')
    holderOf(s.scene.id, s.inst.id)!.expiresAt = Date.now() - 1 // lapsed, not yet swept
    s.editor.room.send('transform_draft', draft(s.inst.id, 6))
    expect(await other.waitFor('transform_draft_end')).toEqual({ sk: s.inst.id, saved: false })
    expect((await other.waitFor('transform_draft')).position.x).toBe(6)
    // The new holder doesn't hear it: its client would snap its own drag back.
    await s.editor.expectNone('transform_draft_end', 200)
    expect(count(s.editor, 'transform_held')).toBe(0)
    expect(holderOf(s.scene.id, s.inst.id)?.key).toBe(`room:${s.editor.room.sessionId}`)
    runDraftSweep(Date.now() + 11 * MIN) // the editor's hold doesn't lapse
    expect(holderOf(s.scene.id, s.inst.id)?.key).toBe(`room:${s.editor.room.sessionId}`)
  })

  it('a headset taking over a lapsed headset hold relays its end first', async () => {
    const s = await setup()
    const other = await pairedHeadset(s.editorU, s.scene.id)
    expect((await s.post(draft(s.inst.id))).statusCode).toBe(204)
    await s.editor.waitFor('transform_draft')
    holderOf(s.scene.id, s.inst.id)!.expiresAt = Date.now() - 1
    expect((await s.post(draft(s.inst.id, 8), other.pass)).statusCode).toBe(204)
    expect(await s.editor.waitFor('transform_draft_end')).toEqual({ sk: s.inst.id, saved: false })
    const got = await s.editor.waitFor('transform_draft')
    expect([got.position.x, got.holderName]).toEqual([8, 'Eddie (headset)'])
    const ends = s.editor.inbox.map((m) => m.type)
    expect(ends).not.toContain('transform_draft_end')
  })

  it('saving a "Just this place" adjustment ends the headset\'s draft of it unsaved', async () => {
    const s = await setup()
    const spaceId = (await app.inject({ method: 'POST', url: `/api/scenes/${s.scene.id}/ar/spaces`, headers: bearer(tokenFor(s.ownerU)), payload: { name: 'Hall' } })).json().id
    expect((await s.post(draft(s.inst.id))).statusCode).toBe(204)
    await s.editor.waitFor('transform_draft')
    const adj = { dPosition: { x: 1, y: 0, z: 0 }, dRotation: { x: 0, y: 0, z: 0 }, scaleFactor: { x: 1, y: 1, z: 1 } }
    const put = await app.inject({ method: 'PUT', url: `/api/ar/spaces/${spaceId}/adjustments/${s.inst.id}`, headers: bearer(s.headset.pass), payload: adj })
    expect(put.statusCode).toBe(200)
    expect(await s.editor.waitFor('transform_draft_end')).toEqual({ sk: s.inst.id, saved: false })
    expect(holderOf(s.scene.id, s.inst.id)).toBeUndefined()

    // Resetting to shared does the same.
    expect((await s.post(draft(s.inst.id))).statusCode).toBe(204)
    await s.editor.waitFor('transform_draft')
    const del = await app.inject({ method: 'DELETE', url: `/api/ar/spaces/${spaceId}/adjustments/${s.inst.id}`, headers: bearer(s.headset.pass) })
    expect(del.statusCode).toBe(204)
    expect(await s.editor.waitFor('transform_draft_end')).toEqual({ sk: s.inst.id, saved: false })
    expect(holderOf(s.scene.id, s.inst.id)).toBeUndefined()

    // An account token's save leaves another holder's draft alone.
    expect((await s.post(draft(s.inst.id))).statusCode).toBe(204)
    await s.editor.waitFor('transform_draft')
    const acct = await app.inject({ method: 'PUT', url: `/api/ar/spaces/${spaceId}/adjustments/${s.inst.id}`, headers: bearer(tokenFor(s.ownerU)), payload: adj })
    expect(acct.statusCode).toBe(200)
    await s.editor.expectNone('transform_draft_end', 200)
    expect(holderOf(s.scene.id, s.inst.id)?.key).toBe(`ar:${s.headset.deviceId}`)
  })

  it('a draft with no room still holds, and a room created later sees the hold', async () => {
    const s = await setup({ join: false })
    expect((await s.post(draft(s.inst.id))).statusCode).toBe(204)
    expect(holderOf(s.scene.id, s.inst.id)?.name).toBe('Olivia (headset)')
    const { editor } = await s.join()
    editor.room.send('transform_draft', draft(s.inst.id, 4))
    expect(await editor.waitFor('transform_held')).toEqual({ sk: s.inst.id, holderName: 'Olivia (headset)' })
  })

  it('drops more than 20 drafts per second per device', async () => {
    const s = await setup()
    const t = Date.now()
    setArDraftClock(() => t)
    for (let i = 0; i < 25; i++) expect((await s.post(draft(s.inst.id, i))).statusCode).toBe(204)
    await new Promise((r) => setTimeout(r, 400))
    expect(count(s.editor, 'transform_draft')).toBe(20)
    setArDraftClock(() => t + 1001)
    expect((await s.post(draft(s.inst.id, 99))).statusCode).toBe(204)
    await new Promise((r) => setTimeout(r, 300))
    expect(count(s.editor, 'transform_draft')).toBe(21)
  })

  it('refuses an account token, a bad draft and an item from another scene', async () => {
    const s = await setup()
    const acct = await s.post(draft(s.inst.id), tokenFor(s.ownerU))
    expect([acct.statusCode, acct.json().error]).toEqual([403, 'ar_pass_required'])
    const acctEnd = await s.end({ sk: s.inst.id, saved: false }, tokenFor(s.ownerU))
    expect([acctEnd.statusCode, acctEnd.json().error]).toEqual([403, 'ar_pass_required'])
    const bad = await s.post({ ...draft(s.inst.id), element: 'widget' })
    expect([bad.statusCode, bad.json().error]).toEqual([400, 'bad_request'])
    const noScale = await s.post({ ...draft(s.inst.id), scale: { x: 1, y: Number.NaN, z: 1 } })
    expect(noScale.statusCode).toBe(400)
    const other = await createScene(await createUser(), 'Other')
    const otherInst = await createInstance((await createElement(other.preset.id)).id)
    const foreign = await s.post(draft(otherInst.id))
    expect([foreign.statusCode, foreign.json().error]).toEqual([403, 'scene_pass_not_allowed'])
    await s.editor.expectNone('transform_draft', 200)
  })

  it('a headset whose approver can no longer build is refused', async () => {
    const s = await setup()
    const editorHeadset = await pairedHeadset(s.editorU, s.scene.id)
    await db.delete(sceneCollaborators)
    const res = await s.post(draft(s.inst.id), editorHeadset.pass)
    expect([res.statusCode, res.json().error]).toEqual([403, 'no_access'])
  })

  it('cloud mode on one process without Redis relays drafts', async () => {
    const s = await setup()
    Object.assign(config, { mode: 'cloud', useRedisPresence: true, redisUrl: undefined })
    expect((await s.post(draft(s.inst.id, 7))).statusCode).toBe(204)
    expect((await s.editor.waitFor('transform_draft')).position.x).toBe(7)
    expect((await s.end({ sk: s.inst.id, saved: true })).statusCode).toBe(204)
    expect(await s.editor.waitFor('transform_draft_end')).toEqual({ sk: s.inst.id, saved: true })
  })

  it('with Redis presence the routes answer 503 drafts_unavailable', async () => {
    const s = await setup()
    Object.assign(config, { mode: 'cloud', useRedisPresence: true, redisUrl: 'redis://localhost:6379' })
    const res = await s.post(draft(s.inst.id))
    expect([res.statusCode, res.json().error]).toEqual([503, 'drafts_unavailable'])
    const ended = await s.end({ sk: s.inst.id, saved: false })
    expect([ended.statusCode, ended.json().error]).toEqual([503, 'drafts_unavailable'])
    await s.editor.expectNone('transform_draft', 200)
  })
})
