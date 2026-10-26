import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { DEFAULT_VENUE_RULES, VENUE_ROLE_SCOPES, parseRingCode } from 'vlm-shared'
import { db } from '../src/db/connection.js'
import { hyperfyPairings, hyperfyWorlds, accessGrants, arFloors, arMarkers, arSpaces, bookings, sceneCollaborators, venues } from '../src/db/schema.js'
import { issueHyperfyPass } from '../src/auth/scene-pass.js'
import { resetDb } from './helpers/db.js'
import { createScene, createUser, randomWallet, testApp, tokenFor, type TestUser } from './helpers/factories.js'

const as = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })

describe('AR spaces setup routes', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(async () => { await app.close() })

  async function setup() {
    const owner = await createUser()
    const { scene, preset } = await createScene(owner)
    return { owner, scene, preset }
  }
  const makeSpace = async (u: TestUser, sceneId: string) => {
    const res = await app.inject({ method: 'POST', url: `/api/scenes/${sceneId}/ar/spaces`, headers: as(u), payload: { name: 'Arcade' } })
    return res.json()
  }

  it('owner creates a space with a ground floor', async () => {
    const s = await setup()
    const res = await app.inject({ method: 'POST', url: `/api/scenes/${s.scene.id}/ar/spaces`, headers: as(s.owner), payload: { name: 'Arcade', place: '1 Main St' } })
    expect(res.statusCode).toBe(201)
    const space = res.json()
    expect(space).toMatchObject({ sceneId: s.scene.id, name: 'Arcade', place: '1 Main St', published: false })
    expect(space.floors[0]).toMatchObject({ name: 'Ground floor', heightM: 0 })
    const list = await app.inject({ method: 'GET', url: `/api/scenes/${s.scene.id}/ar/spaces`, headers: as(s.owner) })
    expect(list.json()).toHaveLength(1)
  })

  it('adds a 140 mm marker with a 7-character code', async () => {
    const s = await setup()
    const space = await makeSpace(s.owner, s.scene.id)
    const res = await app.inject({ method: 'POST', url: `/api/ar/floors/${space.floors[0].id}/markers`, headers: as(s.owner), payload: { whereText: 'By the door' } })
    expect(res.statusCode).toBe(201)
    const m = res.json()
    expect(m.diameterMm).toBe(140)
    expect(m.whereText).toBe('By the door')
    expect(m.pose).toBeNull()
    expect(m.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{7}$/)
    expect(parseRingCode(m.code)).toBe(m.ringId)
  })

  it('editor may set up, viewer may not', async () => {
    const s = await setup()
    const editor = await createUser()
    const viewer = await createUser()
    await db.insert(sceneCollaborators).values([
      { sceneId: s.scene.id, userId: editor.id, role: 'editor' },
      { sceneId: s.scene.id, userId: viewer.id, role: 'viewer' },
    ])
    const url = `/api/scenes/${s.scene.id}/ar/spaces`
    expect((await app.inject({ method: 'POST', url, headers: as(editor), payload: { name: 'A' } })).statusCode).toBe(201)
    const denied = await app.inject({ method: 'POST', url, headers: as(viewer), payload: { name: 'B' } })
    expect(denied.statusCode).toBe(403)
    expect(denied.json().error).toBe('no_access')
  })

  it('booking host may not', async () => {
    const s = await setup()
    const hostWallet = randomWallet()
    const host = await createUser({ wallet: hostWallet })
    const [venue] = await db.insert(venues).values({
      sceneId: s.scene.id, name: 'V', slug: `v-${crypto.randomUUID()}`, defaultPresetId: s.preset.id, rules: DEFAULT_VENUE_RULES,
    }).returning()
    const startsAt = new Date(Date.now() - 3600_000)
    const endsAt = new Date(Date.now() + 3600_000)
    const [booking] = await db.insert(bookings).values({
      venueId: venue.id, renterUserId: host.id, title: 'Show', startsAt, endsAt, status: 'confirmed',
      blockedRange: `[${startsAt.toISOString()},${endsAt.toISOString()})`,
    }).returning()
    await db.insert(accessGrants).values({
      bookingId: booking.id, sceneId: s.scene.id, walletAddress: hostWallet, userId: host.id, role: 'host',
      scopes: [...VENUE_ROLE_SCOPES.host], validFrom: new Date(Date.now() - 3600_000), validUntil: new Date(Date.now() + 3600_000),
    })
    const res = await app.inject({ method: 'POST', url: `/api/scenes/${s.scene.id}/ar/spaces`, headers: as(host), payload: { name: 'X' } })
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toBe('no_access')
  })

  it('rejects a 300 mm marker', async () => {
    const s = await setup()
    const space = await makeSpace(s.owner, s.scene.id)
    const res = await app.inject({ method: 'POST', url: `/api/ar/floors/${space.floors[0].id}/markers`, headers: as(s.owner), payload: { diameterMm: 300 } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('bad_diameter')
  })

  it("won't delete the last floor", async () => {
    const s = await setup()
    const space = await makeSpace(s.owner, s.scene.id)
    const only = await app.inject({ method: 'DELETE', url: `/api/ar/floors/${space.floors[0].id}`, headers: as(s.owner) })
    expect(only.statusCode).toBe(409)
    expect(only.json().error).toBe('last_floor')
    const added = await app.inject({ method: 'POST', url: `/api/ar/spaces/${space.id}/floors`, headers: as(s.owner), payload: { name: 'Upstairs', heightM: 3.2 } })
    expect(added.statusCode).toBe(201)
    expect((await app.inject({ method: 'DELETE', url: `/api/ar/floors/${added.json().id}`, headers: as(s.owner) })).statusCode).toBe(204)
  })

  it('a scene pass is refused on setup routes', async () => {
    const s = await setup()
    const space = await makeSpace(s.owner, s.scene.id)
    const [world] = await db.insert(hyperfyWorlds).values({ sceneId: s.scene.id, ownerId: s.owner.id, name: 'W', keyHash: 'ar-world-hash', keyPrefix: 'vlmw_a' }).returning()
    const [pairing] = await db.insert(hyperfyPairings).values({
      worldId: world.id, userId: s.owner.id, secretHash: 'ar-secret-hash', status: 'claimed', codeExpiresAt: new Date(Date.now() + 3600_000), expiresAt: new Date(Date.now() + 3600_000),
    }).returning()
    const { pass } = issueHyperfyPass(app, s.owner, s.owner.wallet ?? null, { id: pairing.id, worldId: world.id, sceneId: s.scene.id })
    const headers = { authorization: `Bearer ${pass}` }
    for (const [method, url] of [
      ['GET', `/api/scenes/${s.scene.id}/ar/spaces`],
      ['POST', `/api/scenes/${s.scene.id}/ar/spaces`],
      ['PUT', `/api/ar/spaces/${space.id}`],
      ['DELETE', `/api/ar/floors/${space.floors[0].id}`],
    ] as const) {
      const res = await app.inject({ method, url, headers, payload: { name: 'Z' } })
      expect(res.statusCode, `${method} ${url}`).toBe(403)
    }
  })

  it('updates a space and a marker', async () => {
    const s = await setup()
    const space = await makeSpace(s.owner, s.scene.id)
    const put = await app.inject({ method: 'PUT', url: `/api/ar/spaces/${space.id}`, headers: as(s.owner), payload: { published: true, lat: 51.5, lng: -0.1 } })
    expect(put.json()).toMatchObject({ published: true, lat: 51.5, lng: -0.1 })
    const m = (await app.inject({ method: 'POST', url: `/api/ar/floors/${space.floors[0].id}/markers`, headers: as(s.owner), payload: {} })).json()
    const upd = await app.inject({ method: 'PUT', url: `/api/ar/markers/${m.id}`, headers: as(s.owner), payload: { diameterMm: 100 } })
    expect(upd.json()).toMatchObject({ id: m.id, diameterMm: 100, code: m.code })
  })

  it('deleting a space removes its floors and markers', async () => {
    const s = await setup()
    const space = await makeSpace(s.owner, s.scene.id)
    await app.inject({ method: 'POST', url: `/api/ar/floors/${space.floors[0].id}/markers`, headers: as(s.owner), payload: {} })
    expect((await db.select().from(arMarkers)).length).toBe(1)
    const res = await app.inject({ method: 'DELETE', url: `/api/ar/spaces/${space.id}`, headers: as(s.owner) })
    expect(res.statusCode).toBe(204)
    expect((await db.select().from(arSpaces).where(eq(arSpaces.id, space.id))).length).toBe(0)
    expect((await db.select().from(arFloors)).length).toBe(0)
    expect((await db.select().from(arMarkers)).length).toBe(0)
  })

  it('renames a space: owner and editor may, a viewer gets 403; floors and ring codes stay; blank or too long is 400', async () => {
    const s = await setup()
    const editor = await createUser()
    const viewer = await createUser()
    await db.insert(sceneCollaborators).values([
      { sceneId: s.scene.id, userId: editor.id, role: 'editor' },
      { sceneId: s.scene.id, userId: viewer.id, role: 'viewer' },
    ])
    const space = await makeSpace(s.owner, s.scene.id)
    const marker = (await app.inject({ method: 'POST', url: `/api/ar/floors/${space.floors[0].id}/markers`, headers: as(s.owner), payload: {} })).json()
    const rename = (u: TestUser, name: unknown) => app.inject({ method: 'PUT', url: `/api/ar/spaces/${space.id}`, headers: as(u), payload: { name } })

    const ok = await rename(s.owner, '  Moon base  ')
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toMatchObject({ id: space.id, name: 'Moon base', place: space.place, published: space.published })
    expect((await rename(editor, 'Moon base 2')).statusCode).toBe(200)
    const denied = await rename(viewer, 'Nope')
    expect(denied.statusCode).toBe(403)
    for (const bad of ['   ', 'x'.repeat(201), 7]) expect((await rename(s.owner, bad)).statusCode, JSON.stringify(bad)).toBe(400)

    const [row] = await db.select().from(arSpaces).where(eq(arSpaces.id, space.id))
    expect(row.name).toBe('Moon base 2')
    const floors = await db.select().from(arFloors).where(eq(arFloors.spaceId, space.id))
    expect(floors.map((f) => f.id)).toEqual(space.floors.map((f: { id: string }) => f.id))
    const [m] = await db.select().from(arMarkers).where(eq(arMarkers.id, marker.id))
    expect({ code: m.code, ringId: m.ringId }).toEqual({ code: marker.code, ringId: marker.ringId })
  })
})
