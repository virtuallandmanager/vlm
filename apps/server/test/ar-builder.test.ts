import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { arAdjustments, arDevices, sceneElementInstances, sceneCollaborators } from '../src/db/schema.js'
import { issueArPass } from '../src/auth/scene-pass.js'
import { sceneSnapshot } from '../src/hyperfy/snapshot.js'
import { resetDb } from './helpers/db.js'
import { createElement, createInstance, createScene, createUser, testApp, tokenFor, type TestUser } from './helpers/factories.js'

const as = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })
const ADJ = { dPosition: { x: 0.5, y: 0, z: 0 }, dRotation: { x: 0, y: 10, z: 0 }, scaleFactor: { x: 2, y: 1, z: 1 } }

describe('AR builder: alignment saves and per-space adjustments', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let owner: TestUser
  let sceneId: string
  let presetId: string
  let spaceId: string
  let floorId: string
  let markerId: string
  let instanceId: string

  beforeEach(async () => {
    await resetDb()
    app = await testApp()
    owner = await createUser()
    const { scene, preset } = await createScene(owner)
    sceneId = scene.id
    presetId = preset.id
    const space = await newSpace('Arcade')
    spaceId = space.id
    floorId = space.floors[0].id
    markerId = (await app.inject({ method: 'POST', url: `/api/ar/floors/${floorId}/markers`, headers: as(owner), payload: {} })).json().id
    const el = await createElement(presetId, { type: 'model', name: 'Chair', properties: {} })
    instanceId = (await createInstance(el.id)).id
    await app.inject({ method: 'PUT', url: `/api/ar/spaces/${spaceId}`, headers: as(owner), payload: { published: true } })
  })
  afterEach(async () => { await app.close() })

  const newSpace = async (name: string) =>
    (await app.inject({ method: 'POST', url: `/api/scenes/${sceneId}/ar/spaces`, headers: as(owner), payload: { name } })).json()
  const pose = (body: Record<string, unknown>, headers = as(owner)) =>
    app.inject({ method: 'PUT', url: `/api/ar/markers/${markerId}/pose`, headers, payload: { x: 1, y: 0, z: 2, headingDeg: 45, heightAboveFloorM: 0, ...body } })
  const adjust = (sid = spaceId, iid = instanceId, headers = as(owner), body: unknown = ADJ) =>
    app.inject({ method: 'PUT', url: `/api/ar/spaces/${sid}/adjustments/${iid}`, headers, payload: body as any })
  const feed = async (sid = spaceId) => (await app.inject({ method: 'GET', url: `/api/ar/spaces/${sid}/feed`, headers: as(owner) })).json()
  const inst = (f: any) => f.scene.models[0].instances.find((i: any) => i.sk === instanceId)

  it('saves an alignment and the feed carries it', async () => {
    const res = await pose({ x: 1.25, y: 0.1, z: -3, headingDeg: 90 })
    expect(res.statusCode).toBe(200)
    expect(res.json().warnings).toEqual([])
    const expected = { x: 1.25, y: 0.1, z: -3, headingDeg: 90 }
    expect(res.json().marker.pose).toEqual(expected)
    const f = await feed()
    expect(f.space.floors[0].markers[0].pose).toEqual(expected)
  })

  it('warns when the floor is off by more than 0.5 m', async () => {
    expect((await pose({ y: 2.2, heightAboveFloorM: 1.5 })).json().warnings).toEqual(['floor_height_off'])
    expect((await pose({ y: 1.9, heightAboveFloorM: 1.5 })).json().warnings).toEqual([])
  })

  it('heading is normalised', async () => {
    expect((await pose({ headingDeg: 370 })).json().marker.pose.headingDeg).toBe(10)
    expect((await pose({ headingDeg: -90 })).json().marker.pose.headingDeg).toBe(270)
  })

  it('refuses a bad pose', async () => {
    expect((await pose({ x: 'a' })).statusCode).toBe(400)
    expect((await pose({ heightAboveFloorM: undefined })).statusCode).toBe(400)
  })

  it("an adjustment shows only in this space's feed", async () => {
    const b = await newSpace('Other')
    await app.inject({ method: 'PUT', url: `/api/ar/spaces/${b.id}`, headers: as(owner), payload: { published: true } })
    expect((await adjust()).statusCode).toBe(200)
    const a = inst(await feed())
    expect(a.position).toEqual({ x: 1.5, y: 1, z: 1 })
    expect(a.rotation).toEqual({ x: 0, y: 10, z: 0 })
    expect(a.scale).toEqual({ x: 2, y: 1, z: 1 })
    expect(a.arAdjusted).toBe(true)
    const other = inst(await feed(b.id))
    expect(other.position).toEqual({ x: 1, y: 1, z: 1 })
    expect(other.arAdjusted).toBeUndefined()
    const hy = (await sceneSnapshot(sceneId))!.scene as any
    const h = hy.models[0].instances.find((i: any) => i.sk === instanceId)
    expect(h.position).toEqual({ x: 1, y: 1, z: 1 })
    expect(h.arAdjusted).toBeUndefined()
  })

  it('the feed version changes with an adjustment and returns on reset', async () => {
    const v0 = (await feed()).version
    await adjust()
    const v1 = (await feed()).version
    expect(v1).not.toBe(v0)
    expect((await app.inject({ method: 'DELETE', url: `/api/ar/spaces/${spaceId}/adjustments/${instanceId}`, headers: as(owner) })).statusCode).toBe(204)
    expect((await feed()).version).toBe(v0)
    expect(await db.select().from(arAdjustments)).toHaveLength(0)
  })

  it('saving twice replaces the adjustment', async () => {
    await adjust()
    await adjust(spaceId, instanceId, as(owner), { ...ADJ, dPosition: { x: 1, y: 0, z: 0 } })
    const rows = await db.select().from(arAdjustments)
    expect(rows).toHaveLength(1)
    expect(rows[0].dPosition).toEqual({ x: 1, y: 0, z: 0 })
  })

  it('refuses an instance from another scene', async () => {
    const other = await createScene(owner, 'Other scene')
    const el = await createElement(other.preset.id, { type: 'model', properties: {} })
    const foreign = await createInstance(el.id)
    const res = await adjust(spaceId, foreign.id)
    expect([res.statusCode, res.json().error]).toEqual([400, 'instance_not_in_scene'])
  })

  it("refuses an instance from the scene's inactive preset", async () => {
    const { scenePresets } = await import('../src/db/schema.js')
    const [p2] = await db.insert(scenePresets).values({ sceneId, name: 'Other preset' }).returning()
    const el = await createElement(p2.id, { type: 'model', properties: {} })
    const res = await adjust(spaceId, (await createInstance(el.id)).id)
    expect([res.statusCode, res.json().error]).toEqual([400, 'instance_not_in_scene'])
  })

  it('refuses a malformed adjustment', async () => {
    expect((await adjust(spaceId, instanceId, as(owner), { dPosition: { x: 1 } })).statusCode).toBe(400)
    expect((await adjust(spaceId, instanceId, as(owner), { ...ADJ, scaleFactor: { x: 0, y: 1, z: 1 } })).statusCode).toBe(400)
    expect((await adjust(spaceId, 'not-a-uuid')).statusCode).toBe(400)
  })

  it('deleting the instance drops the adjustment', async () => {
    await adjust()
    expect(await db.select().from(arAdjustments)).toHaveLength(1)
    await db.delete(sceneElementInstances).where(eq(sceneElementInstances.id, instanceId))
    expect(await db.select().from(arAdjustments)).toHaveLength(0)
  })

  it('an AR pass may save; a viewer may not', async () => {
    const [device] = await db.insert(arDevices).values({
      userId: owner.id, secretHash: createHash('sha256').update('s').digest('hex'), kind: 'personal', status: 'claimed',
      codeExpiresAt: new Date(), expiresAt: new Date(Date.now() + 3600_000),
    }).returning()
    const { pass } = issueArPass(app, owner, owner.wallet ?? null, { deviceId: device.id, sceneId })
    const ar = { authorization: `Bearer ${pass}` }
    expect((await pose({}, ar)).statusCode).toBe(200)
    expect((await adjust(spaceId, instanceId, ar)).statusCode).toBe(200)
    expect((await app.inject({ method: 'DELETE', url: `/api/ar/spaces/${spaceId}/adjustments/${instanceId}`, headers: ar })).statusCode).toBe(204)

    const viewer = await createUser()
    await db.insert(sceneCollaborators).values({ sceneId, userId: viewer.id, role: 'viewer' })
    expect((await pose({}, as(viewer))).statusCode).toBe(403)
    expect((await adjust(spaceId, instanceId, as(viewer))).statusCode).toBe(403)
  })
})
