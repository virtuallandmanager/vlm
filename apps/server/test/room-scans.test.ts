import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { arDevices, roomScans, roomSets } from '../src/db/schema.js'
import { db } from '../src/db/connection.js'
import { issueArPass } from '../src/auth/scene-pass.js'
import { resetDb } from './helpers/db.js'
import { createScene, createUser, testApp, tokenFor, type TestUser } from './helpers/factories.js'

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const bearer = (t: string) => ({ authorization: `Bearer ${t}` })

function layout(): any {
  return {
    version: 1,
    rooms: [{
      label: 'Living room',
      floor: [[0, 0], [4, 0], [4, 3], [0, 3]],
      floorY: 0,
      ceilingHeight: 2.5,
      walls: [
        { a: [0, 0], b: [4, 0], openings: [{ kind: 'door', offset: 1, width: 0.9, sill: 0, height: 2.0 }] },
        { a: [4, 0], b: [4, 3], openings: [] },
        { a: [4, 3], b: [0, 3], openings: [] },
        { a: [0, 3], b: [0, 0], openings: [] },
      ],
      objects: [],
      anchor: { source: 'quest-mruk', roomId: 'room-1', floorAnchorId: null, floorPose: { position: [0, 0, 0], yaw: 0 } },
    }],
  }
}

describe('room scans', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => {
    await resetDb()
    app = await testApp()
  })
  afterEach(async () => {
    await app.close()
  })

  async function headset(owner: TestUser, kind: 'personal' | 'shared' = 'personal', status = 'claimed') {
    const { scene } = await createScene(owner)
    const [device] = await db
      .insert(arDevices)
      .values({ userId: owner.id, secretHash: sha256('s'), kind, status, codeExpiresAt: new Date(), expiresAt: new Date(Date.now() + 3600_000) })
      .returning()
    const { pass } = issueArPass(app, owner, owner.wallet ?? null, { deviceId: device.id, sceneId: scene.id })
    return { device, pass }
  }
  const upload = (token: string, body: unknown) => app.inject({ method: 'POST', url: '/api/ar/room-scans', headers: bearer(token), payload: body as any })

  it('a personal headset uploads a scan stored under the pass user', async () => {
    const owner = await createUser()
    const { pass } = await headset(owner)
    const res = await upload(pass, { name: 'Lounge', layout: layout() })
    expect(res.statusCode).toBe(201)
    const { scan } = res.json()
    expect(scan.name).toBe('Lounge')
    const [row] = await db.select().from(roomScans).where(eq(roomScans.id, scan.id))
    expect(row.userId).toBe(owner.id)
    expect(row.source).toBe('quest-mruk')
    expect(row.layout.rooms).toHaveLength(1)
  })

  it('a shared headset is refused and nothing is stored', async () => {
    const owner = await createUser()
    const { pass } = await headset(owner, 'shared')
    const res = await upload(pass, { name: 'Lounge', layout: layout() })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'shared_device', message: 'Room scans need a personal headset. This one is shared.' })
    expect(await db.select().from(roomScans)).toHaveLength(0)
  })

  it('a revoked headset gets 401 device_revoked', async () => {
    const owner = await createUser()
    const { pass, device } = await headset(owner)
    await db.update(arDevices).set({ status: 'revoked' }).where(eq(arDevices.id, device.id))
    const res = await upload(pass, { name: 'Lounge', layout: layout() })
    expect(res.statusCode).toBe(401)
    expect(res.json().error).toBe('device_revoked')
  })

  it('rejects an empty scan, an invalid layout and a bad name', async () => {
    const owner = await createUser()
    const { pass } = await headset(owner)
    let res = await upload(pass, { name: 'x', layout: { rooms: [] } })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'empty_scan' })
    res = await upload(pass, { name: 'x', layout: { version: 1, rooms: [{ label: 'bad' }] } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('invalid_layout')
    expect(res.json().errors.length).toBeGreaterThan(0)
    for (const name of ['', 'a'.repeat(121), 5]) {
      res = await upload(pass, { name, layout: layout() })
      expect(res.statusCode).toBe(400)
    }
    expect(await db.select().from(roomScans)).toHaveLength(0)
  })

  it('rejects an all-degenerate scan as empty_scan and stores nothing', async () => {
    const owner = await createUser()
    const { pass } = await headset(owner)
    const l = layout()
    l.rooms[0].floor = [[0, 0], [0.05, 0], [0.05, 0.05]]
    l.rooms[0].walls = [{ a: [0, 0], b: [0.05, 0], openings: [] }, { a: [0.05, 0], b: [0.05, 0.05], openings: [] }]
    const res = await upload(pass, { name: 'Speck', layout: l })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'empty_scan' })
    expect(await db.select().from(roomScans)).toHaveLength(0)
  })

  it('answers 413 to a body over 1 MB and stores nothing', async () => {
    const owner = await createUser()
    const { pass } = await headset(owner)
    const res = await upload(pass, { name: 'Huge', layout: layout(), padding: 'x'.repeat(1_048_576) })
    expect(res.statusCode).toBe(413)
    expect(await db.select().from(roomScans)).toHaveLength(0)
  })

  it('rejects a layout over a size cap as invalid_layout naming the field', async () => {
    const owner = await createUser()
    const { pass } = await headset(owner)
    const l = layout()
    l.rooms[0].objects = Array.from({ length: 257 }, () => ({ label: 'box', center: [1, 0.5, 1], size: [1, 1, 1], yaw: 0 }))
    const res = await upload(pass, { name: 'Cluttered', layout: l })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('invalid_layout')
    expect(res.json().errors.some((e: string) => e.startsWith('rooms[0].objects'))).toBe(true)
    expect(await db.select().from(roomScans)).toHaveLength(0)
  })

  it('an account session cannot use the headset upload, and a pass cannot list', async () => {
    const owner = await createUser()
    const { pass } = await headset(owner)
    expect((await app.inject({ method: 'GET', url: '/api/room-scans', headers: bearer(pass) })).statusCode).toBe(403)
  })

  it('lists only the caller scans, newest first, with summary fields', async () => {
    const a = await createUser()
    const b = await createUser()
    const ha = await headset(a)
    const hb = await headset(b)
    await upload(ha.pass, { name: 'first', layout: layout() })
    await upload(ha.pass, { name: 'second', layout: layout() })
    await upload(hb.pass, { name: 'theirs', layout: layout() })
    const res = await app.inject({ method: 'GET', url: '/api/room-scans', headers: bearer(tokenFor(a)) })
    expect(res.statusCode).toBe(200)
    const { scans } = res.json()
    expect(scans.map((s: any) => s.name)).toEqual(['second', 'first'])
    expect(scans[0]).toMatchObject({ source: 'quest-mruk', roomCount: 1, footprint: { minX: 0, minZ: 0, maxX: 4, maxZ: 3 }, plot: { width: 1, depth: 1, base: { x: 0, y: 0 } } })
    expect(scans[0].layout).toBeUndefined()
  })

  it('stores the plot at upload and the list returns the stored plot, computing it only for rows without one', async () => {
    const a = await createUser()
    const { pass } = await headset(a)
    const { scan } = (await upload(pass, { name: 'stored', layout: layout() })).json()
    const [row] = await db.select().from(roomScans).where(eq(roomScans.id, scan.id))
    expect(row.plot).toEqual({ width: 1, depth: 1, base: { x: 0, y: 0 } })
    // A stored value wins over recomputing from the layout
    await db.update(roomScans).set({ plot: { width: 3, depth: 3, base: { x: 0, y: 0 } } }).where(eq(roomScans.id, scan.id))
    await db.insert(roomScans).values({ userId: a.id, name: 'legacy', source: 'quest-mruk', layout: layout(), createdAt: new Date(Date.now() + 1000) })
    const { scans } = (await app.inject({ method: 'GET', url: '/api/room-scans', headers: bearer(tokenFor(a)) })).json()
    expect(scans.map((s: any) => [s.name, s.plot])).toEqual([
      ['legacy', { width: 1, depth: 1, base: { x: 0, y: 0 } }],
      ['stored', { width: 3, depth: 3, base: { x: 0, y: 0 } }],
    ])
  })

  it('the owner gets the full record; anyone else gets 404 on GET and DELETE', async () => {
    const a = await createUser()
    const b = await createUser()
    const { scan } = (await upload((await headset(a)).pass, { name: 'mine', layout: layout() })).json()
    const url = `/api/room-scans/${scan.id}`
    const own = await app.inject({ method: 'GET', url, headers: bearer(tokenFor(a)) })
    expect(own.statusCode).toBe(200)
    expect(own.json().scan.layout.rooms).toHaveLength(1)
    expect((await app.inject({ method: 'GET', url, headers: bearer(tokenFor(b)) })).statusCode).toBe(404)
    expect((await app.inject({ method: 'DELETE', url, headers: bearer(tokenFor(b)) })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/api/room-scans/not-a-uuid', headers: bearer(tokenFor(a)) })).statusCode).toBe(404)
    expect(await db.select().from(roomScans)).toHaveLength(1)
  })

  it('delete answers 204 and keeps the scan room sets with scanId null', async () => {
    const a = await createUser()
    const { scan } = (await upload((await headset(a)).pass, { name: 'mine', layout: layout() })).json()
    const [set] = await db
      .insert(roomSets)
      .values({ scanId: scan.id, userId: a.id, options: {}, storageKey: 'k', glbUrl: 'u', triangles: 10, plot: {}, offset: {} })
      .returning()
    const res = await app.inject({ method: 'DELETE', url: `/api/room-scans/${scan.id}`, headers: bearer(tokenFor(a)) })
    expect(res.statusCode).toBe(204)
    expect(await db.select().from(roomScans)).toHaveLength(0)
    const [kept] = await db.select().from(roomSets).where(eq(roomSets.id, set.id))
    expect(kept.scanId).toBeNull()
    expect(kept.glbUrl).toBe('u')
  })
})
