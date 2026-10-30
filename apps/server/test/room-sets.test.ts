import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import type { RoomScanLayout, ScannedRoom } from '@virvixr/shared'
import { assetLibraryItems, roomScans, roomSets, sceneElements } from '../src/db/schema.js'
import { db } from '../src/db/connection.js'
import type { StorageProvider } from '../src/storage/index.js'
import { glbStats } from '../src/catalog/glb-stats.js'
import { buildRoomSetGlb, DEFAULT_ROOM_SET_OPTIONS } from '../src/room-scan/build-glb.js'
import { snapDoors, wallsFromOutline } from '../src/room-scan/geometry.js'
import { commitRoomSet, copyRoomSetForScene, createRoomSet, insertRoomSet, prepareRoomSet, setRoomSetStorage } from '../src/room-scan/sets.js'
import { resetDb } from './helpers/db.js'
import { createElement, createScene, createUser, testApp, tokenFor, type TestUser } from './helpers/factories.js'

const ANCHOR: ScannedRoom['anchor'] = { source: 'quest-mruk', roomId: 'r', floorAnchorId: null, floorPose: { position: [0, 0, 0], yaw: 0 } }
const bearer = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })

function rect(w: number, d: number): RoomScanLayout {
  const floor: Array<[number, number]> = [[0, 0], [w, 0], [w, d], [0, d]]
  const walls = wallsFromOutline(floor)
  walls[0].openings = [{ kind: 'door', offset: 1, width: 0.9, sill: 0, height: 2 }]
  return { version: 1, rooms: [{ label: 'Room', floor, floorY: 0, ceilingHeight: 2.5, walls, objects: [], anchor: ANCHOR }] }
}

/** Two rooms whose doors are (0.2, 0.1) apart, so snapping moves the second room. */
function twoRooms(): RoomScanLayout {
  const door = [{ kind: 'door' as const, offset: 1, width: 0.9, sill: 0, height: 2.1 }]
  const room = (floor: Array<[number, number]>, wall: { a: [number, number]; b: [number, number] }): ScannedRoom =>
    ({ label: 'Room', floor, floorY: 0, ceilingHeight: 2.5, walls: [{ ...wall, openings: door }], objects: [], anchor: ANCHOR })
  return {
    version: 1,
    rooms: [
      room([[0, 0], [4, 0], [4, 3], [0, 3]], { a: [4, 0], b: [4, 3] }),
      room([[4.2, 0.1], [8.2, 0.1], [8.2, 3.1], [4.2, 3.1]], { a: [4.2, 0.1], b: [4.2, 3.1] }),
    ],
  }
}

const memoryStorage = () => {
  const files = new Map<string, Buffer>()
  const storage: StorageProvider = {
    upload: async (key, data) => { files.set(key, data); return `https://cdn.test/${key}` },
    delete: async (key) => { files.delete(key) },
    getPublicUrl: (key) => `https://cdn.test/${key}`,
  }
  return { storage, files }
}

describe('room sets', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let files: Map<string, Buffer>
  beforeEach(async () => {
    await resetDb()
    const mem = memoryStorage()
    files = mem.files
    setRoomSetStorage(mem.storage)
    app = await testApp()
  })
  afterEach(async () => {
    setRoomSetStorage(null)
    await app.close()
  })

  async function scanFor(owner: TestUser, layout: RoomScanLayout = rect(4, 3)) {
    const [scan] = await db.insert(roomScans).values({ userId: owner.id, name: 'Lounge', source: 'quest-mruk', layout }).returning()
    return scan
  }
  const makeAsset = (u: TestUser, body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/room-sets/asset', headers: bearer(u), payload: body })
  const put = (u: TestUser, id: string, body: Record<string, unknown>) =>
    app.inject({ method: 'PUT', url: `/api/room-sets/${id}`, headers: bearer(u), payload: body })
  const setOf = async (assetId: string) => (await db.select().from(roomSets).where(eq(roomSets.assetItemId, assetId)))[0]

  describe('POST /api/room-sets/asset', () => {
    it('stores a private room asset with measured stats, seen by its owner only', async () => {
      const owner = await createUser(); const other = await createUser()
      const scan = await scanFor(owner)
      const res = await makeAsset(owner, { scanId: scan.id, name: 'My lounge', options: { style: 'house' } })
      expect(res.statusCode).toBe(201)
      const { asset } = res.json()
      expect(asset).toMatchObject({ name: 'My lounge', isPublic: false, uploadedBy: owner.id, category: 'room' })
      expect(asset.storageKey).toMatch(new RegExp(`^room-sets/${owner.id}/[0-9a-f-]{36}\\.glb$`))
      expect(asset.cdnUrl).toBe(`https://cdn.test/${asset.storageKey}`)
      const stats = await glbStats(files.get(asset.storageKey)!)
      expect(asset.triangleCount).toBe(stats.triangles)
      expect(asset.dimensions).toEqual({ width: stats.bbox.x, height: stats.bbox.y, depth: stats.bbox.z })
      expect(asset.fileSizeBytes).toBe(files.get(asset.storageKey)!.length)

      const set = await setOf(asset.id)
      expect(set).toMatchObject({ scanId: scan.id, userId: owner.id, storageKey: asset.storageKey, glbUrl: asset.cdnUrl, triangles: stats.triangles })
      expect(set.options).toMatchObject({ style: 'house', wallColor: '#E8E6E1', floorColor: '#B9A68C', ceiling: false, furniture: false })
      expect(set.plot).toEqual({ width: 1, depth: 1, base: { x: 0, y: 0 } })
      expect((set.offset as any).x).toBeCloseTo(0.62)

      const list = async (u?: TestUser) =>
        (await app.inject({ method: 'GET', url: '/api/assets', headers: u ? bearer(u) : {} })).json().assets.map((a: any) => a.id)
      expect(await list(owner)).toContain(asset.id)
      expect(await list(other)).not.toContain(asset.id)
      expect(await list()).not.toContain(asset.id)
    })

    it("answers 422 too_big for a home larger than the largest plot and stores nothing", async () => {
      const owner = await createUser()
      const scan = await scanFor(owner, rect(10 * 16, 4))
      const res = await makeAsset(owner, { scanId: scan.id, name: 'Mansion', options: {} })
      expect(res.statusCode).toBe(422)
      expect(res.json()).toEqual({ error: 'too_big' })
      expect(files.size).toBe(0)
      expect(await db.select().from(roomSets)).toHaveLength(0)
      expect(await db.select().from(assetLibraryItems)).toHaveLength(0)
    })

    it("answers 404 for another user's scan and 400 for a bad style", async () => {
      const owner = await createUser(); const other = await createUser()
      const scan = await scanFor(owner)
      expect((await makeAsset(other, { scanId: scan.id, name: 'Mine now', options: {} })).statusCode).toBe(404)
      expect((await makeAsset(owner, { scanId: scan.id, name: 'Bad', options: { style: 'castle' } })).statusCode).toBe(400)
      expect((await makeAsset(owner, { scanId: scan.id, name: '', options: {} })).statusCode).toBe(400)
      expect(files.size).toBe(0)
    })

    it('deletes the uploaded object when the insert fails', async () => {
      const owner = await createUser()
      const scan = await scanFor(owner)
      const prepared = await prepareRoomSet(owner.id, scan, DEFAULT_ROOM_SET_OPTIONS, [])
      expect(files.has(prepared.storageKey)).toBe(true)
      await expect(
        commitRoomSet(prepared, async (tx) => {
          await insertRoomSet(prepared, {}, tx)
          throw new Error('later step failed')
        }),
      ).rejects.toThrow('later step failed')
      expect(files.has(prepared.storageKey)).toBe(false)
      expect(await db.select().from(roomSets)).toHaveLength(0)
      // createRoomSet composes prepare + insert and cleans up the same way
      await db.delete(roomScans).where(eq(roomScans.id, scan.id))
      await expect(createRoomSet(owner.id, scan.id, DEFAULT_ROOM_SET_OPTIONS, [])).rejects.toMatchObject({ status: 404 })
      expect(await db.select().from(roomSets)).toHaveLength(0)
    })
  })

  describe('PUT /api/room-sets/:id', () => {
    it("restyles one set under a new key, deletes the old object and leaves a sibling set alone", async () => {
      const owner = await createUser()
      const scan = await scanFor(owner)
      const first = (await makeAsset(owner, { scanId: scan.id, name: 'One', options: {} })).json().asset
      const second = (await makeAsset(owner, { scanId: scan.id, name: 'Two', options: {} })).json().asset
      const setA = await setOf(first.id), setB = await setOf(second.id)

      const res = await put(owner, setA.id, { options: { style: 'dollhouse', wallColor: '#112233' } })
      expect(res.statusCode).toBe(200)
      const { set } = res.json()
      expect(set.storageKey).not.toBe(setA.storageKey)
      expect(set.storageKey).toMatch(new RegExp(`^room-sets/${owner.id}/[0-9a-f-]{36}\\.glb$`))
      expect(set.options).toMatchObject({ style: 'dollhouse', wallColor: '#112233', floorColor: '#B9A68C' })
      expect(files.has(setA.storageKey)).toBe(false)
      expect(files.has(set.storageKey)).toBe(true)

      // The asset follows its set
      const [asset] = await db.select().from(assetLibraryItems).where(eq(assetLibraryItems.id, first.id))
      const stats = await glbStats(files.get(set.storageKey)!)
      expect(asset).toMatchObject({ storageKey: set.storageKey, cdnUrl: set.glbUrl, triangleCount: stats.triangles })
      expect(asset.dimensions).toEqual({ width: stats.bbox.x, height: stats.bbox.y, depth: stats.bbox.z })

      // The sibling is untouched
      const [b] = await db.select().from(roomSets).where(eq(roomSets.id, setB.id))
      expect(b).toEqual(setB)
      expect(files.has(setB.storageKey)).toBe(true)
    })

    it("points a scene element's modelSrc at the new GLB", async () => {
      const owner = await createUser()
      const scan = await scanFor(owner)
      const { preset } = await createScene(owner)
      const element = await createElement(preset.id, { type: 'model', name: 'Room', properties: { modelSrc: 'https://old/x.glb', keep: 1 } })
      const prepared = await prepareRoomSet(owner.id, scan, DEFAULT_ROOM_SET_OPTIONS, [])
      const row = await insertRoomSet(prepared, { sceneElementId: element.id })

      const res = await put(owner, row.id, { options: { style: 'storefront' } })
      expect(res.statusCode).toBe(200)
      const [el] = await db.select().from(sceneElements).where(eq(sceneElements.id, element.id))
      expect(el.properties).toEqual({ modelSrc: res.json().set.glbUrl, keep: 1 })
    })

    it('saves validated nudges and snaps doors when asked', async () => {
      const owner = await createUser()
      const layout = twoRooms()
      const scan = await scanFor(owner, layout)
      const row = await createRoomSet(owner.id, scan.id, DEFAULT_ROOM_SET_OPTIONS, [])

      expect((await put(owner, row.id, { nudges: [{ dx: 0, dz: 0, yaw: 0 }] })).statusCode).toBe(400)
      expect((await put(owner, row.id, { nudges: [{ dx: 0, dz: 0, yaw: 0 }, { dx: 'x', dz: 0, yaw: 0 }] })).statusCode).toBe(400)
      expect((await put(owner, row.id, { nudges: 'nope' })).statusCode).toBe(400)

      const nudges = [{ dx: 0, dz: 0, yaw: 0 }, { dx: -0.05, dz: 0, yaw: 0 }]
      const plain = await put(owner, row.id, { nudges })
      expect(plain.statusCode).toBe(200)
      expect(plain.json().set.nudges).toEqual(nudges)

      const snapped = await put(owner, row.id, { nudges, snap: true })
      expect(snapped.statusCode).toBe(200)
      const expected = snapDoors(layout, nudges)
      expect(expected).not.toEqual(nudges)
      expect(snapped.json().set.nudges).toEqual(expected)
    })

    it("answers 404 to another user and changes nothing", async () => {
      const owner = await createUser(); const other = await createUser()
      const scan = await scanFor(owner)
      const row = await createRoomSet(owner.id, scan.id, DEFAULT_ROOM_SET_OPTIONS, [])
      const res = await put(other, row.id, { options: { style: 'house' } })
      expect(res.statusCode).toBe(404)
      expect((await put(other, '00000000-0000-0000-0000-000000000000', {})).statusCode).toBe(404)
      expect((await put(other, 'not-a-uuid', {})).statusCode).toBe(404)
      const [after] = await db.select().from(roomSets).where(eq(roomSets.id, row.id))
      expect(after).toEqual(row)
      expect([...files.keys()]).toEqual([row.storageKey])
    })
  })

  describe('copyRoomSetForScene', () => {
    it("makes a scene-owned copy that a later PUT on the asset's set doesn't change", async () => {
      const owner = await createUser(); const other = await createUser()
      const scan = await scanFor(owner)
      const asset = (await makeAsset(owner, { scanId: scan.id, name: 'Snap', options: { style: 'house' } })).json().asset
      const source = await setOf(asset.id)

      const copy = await copyRoomSetForScene(asset.id, owner.id)
      expect(copy.id).not.toBe(source.id)
      expect(copy.storageKey).not.toBe(source.storageKey)
      expect(copy).toMatchObject({ scanId: scan.id, userId: owner.id, options: source.options, nudges: source.nudges, assetItemId: null, sceneElementId: null })
      expect(files.has(copy.storageKey)).toBe(true)
      await expect(copyRoomSetForScene(asset.id, other.id)).rejects.toMatchObject({ status: 404 })

      expect((await put(owner, source.id, { options: { style: 'plain' } })).statusCode).toBe(200)
      const [after] = await db.select().from(roomSets).where(eq(roomSets.id, copy.id))
      expect(after).toEqual(copy)
      expect(files.has(copy.storageKey)).toBe(true)
    })
  })

  describe('GET /api/room-scans/:id/preview.glb', () => {
    it('returns the GLB buildRoomSetGlb makes, with its triangle count, storing nothing', async () => {
      const owner = await createUser()
      const scan = await scanFor(owner)
      const res = await app.inject({
        method: 'GET',
        url: `/api/room-scans/${scan.id}/preview.glb?style=house&wallColor=%23336699&floorColor=%23998877&ceiling=true&furniture=1`,
        headers: bearer(owner),
      })
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-type']).toBe('model/gltf-binary')
      const expected = await buildRoomSetGlb(scan.layout, { style: 'house', wallColor: '#336699', floorColor: '#998877', ceiling: true, furniture: true })
      const stats = await glbStats(res.rawPayload)
      expect(stats).toEqual(await glbStats(expected.glb))
      expect(res.headers['x-triangles']).toBe(String(expected.triangles))
      expect(res.headers['access-control-expose-headers']).toContain('X-Triangles')
      expect(files.size).toBe(0)
      expect(await db.select().from(roomSets)).toHaveLength(0)
    })

    it('uses the defaults when the query is empty and refuses an unknown style', async () => {
      const owner = await createUser()
      const scan = await scanFor(owner)
      const res = await app.inject({ method: 'GET', url: `/api/room-scans/${scan.id}/preview.glb`, headers: bearer(owner) })
      expect(res.statusCode).toBe(200)
      const expected = await buildRoomSetGlb(scan.layout, DEFAULT_ROOM_SET_OPTIONS)
      expect(await glbStats(res.rawPayload)).toEqual(await glbStats(expected.glb))
      const bad = await app.inject({ method: 'GET', url: `/api/room-scans/${scan.id}/preview.glb?style=castle`, headers: bearer(owner) })
      expect(bad.statusCode).toBe(400)
    })

    it("answers 404 to another user and 422 too_big for an oversized home", async () => {
      const owner = await createUser(); const other = await createUser()
      const scan = await scanFor(owner)
      expect((await app.inject({ method: 'GET', url: `/api/room-scans/${scan.id}/preview.glb`, headers: bearer(other) })).statusCode).toBe(404)
      const big = await scanFor(owner, rect(10 * 16, 4))
      const res = await app.inject({ method: 'GET', url: `/api/room-scans/${big.id}/preview.glb`, headers: bearer(owner) })
      expect(res.statusCode).toBe(422)
      expect(res.json()).toEqual({ error: 'too_big' })
    })
  })
})
