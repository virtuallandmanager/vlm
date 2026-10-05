import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { sceneElementInstances, sceneElements, accessGrants, scenes, scenePresets, sceneCollaborators } from '../src/db/schema.js'
import { getSceneAccess } from '../src/auth/permissions.js'
import { actorFromClaims } from '../src/auth/actor.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, createElement, createInstance, tokenFor, randomWallet } from './helpers/factories.js'

const H = 3600_000
const as = (u: any) => ({ authorization: `Bearer ${tokenFor(u)}` })

describe('/api/venues', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => {
    await resetDb()
    app = await testApp()
  })
  afterEach(() => app.close())

  async function venueSetup() {
    const admin = await createUser({ role: 'admin' })
    const { scene, preset } = await createScene(admin)
    const screen = await createElement(preset.id, { type: 'video' })
    const wall = await createElement(preset.id, { type: 'model', name: 'Wall' })
    await createInstance(screen.id)
    const res = await app.inject({
      method: 'POST',
      url: '/api/venues',
      headers: as(admin),
      payload: { sceneId: scene.id, name: 'Caldera Lounge', slug: 'caldera', rentableElementIds: [screen.id] },
    })
    expect(res.statusCode).toBe(201)
    return { admin, scene, preset, screen, wall, venue: res.json().venue }
  }

  async function book(s: Awaited<ReturnType<typeof venueSetup>>, renterWallet: string, startInMs = 24 * H, hours = 2) {
    const startsAt = new Date(Date.now() + startInMs)
    return app.inject({
      method: 'POST',
      url: `/api/venues/${s.venue.id}/bookings`,
      headers: as(s.admin),
      payload: {
        renterWallet,
        title: 'Friday Set',
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + hours * H).toISOString(),
      },
    })
  }

  it('creates a venue from the active preset and rejects non-preset rentable ids', async () => {
    const s = await venueSetup()
    expect(s.venue.defaultPresetId).toBe(s.preset.id)
    expect(s.venue.rules.setupLeadMinutes).toBe(60)
    const other = await createScene(s.admin, 'Other')
    const foreign = await createElement(other.preset.id)
    const bad = await app.inject({
      method: 'POST',
      url: '/api/venues',
      headers: as(s.admin),
      payload: { sceneId: other.scene.id, name: 'X', slug: 'x', rentableElementIds: [s.screen.id, foreign.id] },
    })
    expect(bad.statusCode).toBe(400)
  })

  it('a creator cannot turn someone else’s scene into a venue', async () => {
    const s = await venueSetup()
    const creator = await createUser()
    const other = await createScene(s.admin, 'Other')
    const res = await app.inject({
      method: 'POST',
      url: '/api/venues',
      headers: as(creator),
      payload: { sceneId: other.scene.id, name: 'Y', slug: 'y' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('booking clones the preset, creates the host grant and blocks overlaps', async () => {
    const s = await venueSetup()
    const wallet = randomWallet()
    const res = await book(s, wallet)
    expect(res.statusCode).toBe(201)
    const { booking, hostGrant } = res.json()
    expect(booking.status).toBe('confirmed')
    expect(booking.bookingPresetId).not.toBe(s.preset.id)
    expect(hostGrant.role).toBe('host')
    expect(hostGrant.walletAddress).toBe(wallet)
    expect(new Date(hostGrant.validUntil).getTime()).toBe(new Date(booking.endsAt).getTime() + 15 * 60_000)

    const clones = await db.select().from(sceneElements).where(eq(sceneElements.presetId, booking.bookingPresetId))
    expect(clones.map((c) => c.clonedFromId).sort()).toEqual([s.screen.id, s.wall.id].sort())

    const overlap = await book(s, randomWallet(), 24 * H + 30 * 60_000)
    expect(overlap.statusCode).toBe(409)
  })

  it.each([
    ['unparseable date', { startsAt: 'soon', endsAt: 'later' }],
    ['end before start', { startsAt: new Date(Date.now() + 5 * H).toISOString(), endsAt: new Date(Date.now() + 4 * H).toISOString() }],
    ['too long', { startsAt: new Date(Date.now() + 5 * H).toISOString(), endsAt: new Date(Date.now() + 20 * H).toISOString() }],
    ['too short', { startsAt: new Date(Date.now() + 5 * H).toISOString(), endsAt: new Date(Date.now() + 5.5 * H).toISOString() }],
    ['already over', { startsAt: new Date(Date.now() - 5 * H).toISOString(), endsAt: new Date(Date.now() - 3 * H).toISOString() }],
  ])('rejects bad booking times: %s', async (_label, times) => {
    const s = await venueSetup()
    const res = await app.inject({
      method: 'POST',
      url: `/api/venues/${s.venue.id}/bookings`,
      headers: as(s.admin),
      payload: { renterWallet: randomWallet(), title: 'x', ...times },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBeTruthy()
  })

  it('only admins can create bookings for now', async () => {
    const s = await venueSetup()
    const creator = await createUser()
    const res = await app.inject({
      method: 'POST',
      url: `/api/venues/${s.venue.id}/bookings`,
      headers: as(creator),
      payload: { renterWallet: randomWallet(), title: 'x', startsAt: new Date(Date.now() + 5 * H).toISOString(), endsAt: new Date(Date.now() + 7 * H).toISOString() },
    })
    expect(res.statusCode).toBe(403)
  })

  it('host adds crew by checksummed wallet; crew signs in lowercase and gets access', async () => {
    const s = await venueSetup()
    const hostWallet = randomWallet()
    const host = await createUser({ wallet: hostWallet })
    const { booking } = (await book(s, hostWallet)).json()

    const crewWallet = randomWallet()
    const mixedCase = '0x' + crewWallet.slice(2).toUpperCase()
    const add = await app.inject({
      method: 'POST',
      url: `/api/venues/bookings/${booking.id}/grants`,
      headers: as(host),
      payload: { walletAddress: mixedCase, role: 'vj' },
    })
    expect(add.statusCode).toBe(201)
    expect(add.json().grant.walletAddress).toBe(crewWallet)
    expect(add.json().grant.scopes.sort()).toEqual(['playlist', 'schedule', 'screens'])

    const crew = await createUser({ wallet: crewWallet })
    const access = await getSceneAccess(actorFromClaims({ id: crew.id, role: 'creator', wallet: crewWallet, verified: true }), s.scene.id)
    expect(access.level).toBe('grant')
  })

  it('scope tweaks, role reset, and invalid wallet', async () => {
    const s = await venueSetup()
    const hostWallet = randomWallet()
    const host = await createUser({ wallet: hostWallet })
    const { booking } = (await book(s, hostWallet)).json()
    const bad = await app.inject({
      method: 'POST',
      url: `/api/venues/bookings/${booking.id}/grants`,
      headers: as(host),
      payload: { walletAddress: 'not-a-wallet', role: 'vj' },
    })
    expect(bad.statusCode).toBe(400)

    const { grant } = (
      await app.inject({
        method: 'POST',
        url: `/api/venues/bookings/${booking.id}/grants`,
        headers: as(host),
        payload: { walletAddress: randomWallet(), role: 'performer', scopes: ['lights.cue', 'lights.faders'] },
      })
    ).json()
    expect(grant.scopes.sort()).toEqual(['lights.cue', 'lights.faders'])

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/venues/grants/${grant.id}`,
      headers: as(host),
      payload: { role: 'door' },
    })
    expect(patched.json().grant.scopes).toEqual(['moderation'])
  })

  it('crew grants cannot outlast the host grant', async () => {
    const s = await venueSetup()
    const hostWallet = randomWallet()
    const host = await createUser({ wallet: hostWallet })
    const { booking, hostGrant } = (await book(s, hostWallet)).json()
    const res = await app.inject({
      method: 'POST',
      url: `/api/venues/bookings/${booking.id}/grants`,
      headers: as(host),
      payload: {
        walletAddress: randomWallet(),
        role: 'vj',
        validUntil: new Date(new Date(hostGrant.validUntil).getTime() + H).toISOString(),
      },
    })
    expect(res.statusCode).toBe(400)
  })

  it('cohost cannot revoke the host; vj cannot manage crew; nobody can create a host grant', async () => {
    const s = await venueSetup()
    const hostWallet = randomWallet()
    const host = await createUser({ wallet: hostWallet })
    const { booking, hostGrant } = (await book(s, hostWallet)).json()
    const cohostWallet = randomWallet()
    const vjWallet = randomWallet()
    const cohost = await createUser({ wallet: cohostWallet })
    const vj = await createUser({ wallet: vjWallet })
    for (const [w, role] of [[cohostWallet, 'cohost'], [vjWallet, 'vj']] as const) {
      const r = await app.inject({ method: 'POST', url: `/api/venues/bookings/${booking.id}/grants`, headers: as(host), payload: { walletAddress: w, role } })
      expect(r.statusCode).toBe(201)
    }
    expect((await app.inject({ method: 'DELETE', url: `/api/venues/grants/${hostGrant.id}`, headers: as(cohost) })).statusCode).toBe(403)
    expect(
      (await app.inject({ method: 'POST', url: `/api/venues/bookings/${booking.id}/grants`, headers: as(vj), payload: { walletAddress: randomWallet(), role: 'door' } })).statusCode,
    ).toBe(403)
    expect(
      (await app.inject({ method: 'POST', url: `/api/venues/bookings/${booking.id}/grants`, headers: as(host), payload: { walletAddress: randomWallet(), role: 'host' } })).statusCode,
    ).toBe(400)
  })

  it('revoke removes access; cancel revokes everything', async () => {
    const s = await venueSetup()
    const hostWallet = randomWallet()
    const host = await createUser({ wallet: hostWallet })
    const { booking } = (await book(s, hostWallet)).json()
    const crewWallet = randomWallet()
    const crew = await createUser({ wallet: crewWallet })
    const { grant } = (
      await app.inject({ method: 'POST', url: `/api/venues/bookings/${booking.id}/grants`, headers: as(host), payload: { walletAddress: crewWallet, role: 'vj' } })
    ).json()
    expect((await app.inject({ method: 'DELETE', url: `/api/venues/grants/${grant.id}`, headers: as(host) })).statusCode).toBe(204)
    const crewActor = actorFromClaims({ id: crew.id, role: 'creator', wallet: crewWallet, verified: true })
    expect((await getSceneAccess(crewActor, s.scene.id)).level).toBe('none')

    const cancel = await app.inject({ method: 'POST', url: `/api/venues/bookings/${booking.id}/cancel`, headers: as(s.admin) })
    expect(cancel.statusCode).toBe(200)
    const hostActor = actorFromClaims({ id: host.id, role: 'creator', wallet: hostWallet, verified: true })
    expect((await getSceneAccess(hostActor, s.scene.id)).level).toBe('none')
    const live = await db.query.scenes.findFirst({ where: eq(scenes.id, s.scene.id) })
    expect(live!.activePresetId).toBe(s.preset.id)
  })

  it('GET /api/venues/bookings/mine lists bookings where I hold an active grant', async () => {
    const s = await venueSetup()
    const hostWallet = randomWallet()
    const host = await createUser({ wallet: hostWallet })
    const { booking } = (await book(s, hostWallet)).json()
    const res = await app.inject({ method: 'GET', url: '/api/venues/bookings/mine', headers: as(host) })
    expect(res.json().bookings.map((b: any) => b.id)).toEqual([booking.id])
    expect(res.json().bookings[0].role).toBe('host')
  })

  it('cohost can revoke a vj grant', async () => {
    const s = await venueSetup()
    const hostWallet = randomWallet()
    const host = await createUser({ wallet: hostWallet })
    const { booking } = (await book(s, hostWallet)).json()
    const cohostWallet = randomWallet()
    const cohost = await createUser({ wallet: cohostWallet })
    const url = `/api/venues/bookings/${booking.id}/grants`
    expect((await app.inject({ method: 'POST', url, headers: as(host), payload: { walletAddress: cohostWallet, role: 'cohost' } })).statusCode).toBe(201)
    const vj = (await app.inject({ method: 'POST', url, headers: as(host), payload: { walletAddress: randomWallet(), role: 'vj' } })).json().grant
    expect((await app.inject({ method: 'DELETE', url: `/api/venues/grants/${vj.id}`, headers: as(cohost) })).statusCode).toBe(204)
  })

  it('crew of booking A cannot manage booking B at the same venue', async () => {
    const s = await venueSetup()
    const hostWallet = randomWallet()
    const host = await createUser({ wallet: hostWallet })
    const a = (await book(s, hostWallet)).json().booking
    const b = (await book(s, randomWallet(), 72 * H)).json().booking
    const cohostWallet = randomWallet()
    const cohost = await createUser({ wallet: cohostWallet })
    expect((await app.inject({ method: 'POST', url: `/api/venues/bookings/${a.id}/grants`, headers: as(host), payload: { walletAddress: cohostWallet, role: 'cohost' } })).statusCode).toBe(201)
    expect((await app.inject({ method: 'GET', url: `/api/venues/bookings/${b.id}/grants`, headers: as(cohost) })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: `/api/venues/bookings/${b.id}/grants`, headers: as(cohost), payload: { walletAddress: randomWallet(), role: 'vj' } })).statusCode).toBe(403)
  })

  it('a host with two bookings can add crew to the later one', async () => {
    const s = await venueSetup()
    const hostWallet = randomWallet()
    const host = await createUser({ wallet: hostWallet })
    await book(s, hostWallet)
    const later = (await book(s, hostWallet, 72 * H)).json().booking
    const res = await app.inject({ method: 'POST', url: `/api/venues/bookings/${later.id}/grants`, headers: as(host), payload: { walletAddress: randomWallet(), role: 'vj' } })
    expect(res.statusCode).toBe(201)
  })

  it('rejects bad venue rules on create and patch', async () => {
    const s = await venueSetup()
    const other = await createScene(s.admin, 'Other')
    for (const rules of [{ bufferMinutes: 'x' }, { minHours: 5, maxHours: 2 }, { graceMinutes: -1 }, { graceMinutes: 7.5 }]) {
      const c = await app.inject({ method: 'POST', url: '/api/venues', headers: as(s.admin), payload: { sceneId: other.scene.id, name: 'R', slug: 'r', rules } })
      expect(c.statusCode).toBe(400)
      const p = await app.inject({ method: 'PATCH', url: `/api/venues/${s.venue.id}`, headers: as(s.admin), payload: { rules } })
      expect(p.statusCode).toBe(400)
    }
  })

  it('an unverified admin token cannot create bookings', async () => {
    const s = await venueSetup()
    const startsAt = new Date(Date.now() + 24 * H)
    const res = await app.inject({
      method: 'POST',
      url: `/api/venues/${s.venue.id}/bookings`,
      headers: { authorization: `Bearer ${tokenFor(s.admin, { verified: false })}` },
      payload: { renterWallet: randomWallet(), title: 'x', startsAt: startsAt.toISOString(), endsAt: new Date(startsAt.getTime() + 2 * H).toISOString() },
    })
    expect(res.statusCode).toBe(403)
  })

  it('grant holders see only the active and their own booking preset, and no collaborators', async () => {
    const s = await venueSetup()
    const hostWallet = randomWallet()
    const host = await createUser({ wallet: hostWallet })
    const { booking } = (await book(s, hostWallet)).json()
    const other = (await book(s, randomWallet(), 72 * H)).json().booking
    const extra = await db.insert(scenePresets).values({ sceneId: s.scene.id, name: 'Owner Private' }).returning()
    const collab = await createUser({ email: 'collab@secret.dev' })
    await db.insert(sceneCollaborators).values({ sceneId: s.scene.id, userId: collab.id, role: 'viewer' })

    const res = await app.inject({ method: 'GET', url: `/api/scenes/${s.scene.id}`, headers: as(host) })
    expect(res.statusCode).toBe(200)
    const scene = res.json().scene
    expect(scene.collaborators).toBeUndefined()
    const ids = scene.presets.map((p: any) => p.id).sort()
    expect(ids).toEqual([s.preset.id, booking.bookingPresetId].sort())
    expect(ids).not.toContain(other.bookingPresetId)
    expect(ids).not.toContain(extra[0].id)
    expect(JSON.stringify(res.json())).not.toContain('collab@secret.dev')

    const collabs = await app.inject({ method: 'GET', url: `/api/scenes/${s.scene.id}/collaborators`, headers: as(host) })
    expect(collabs.statusCode).toBe(403)

    // the owner still gets everything
    const own = await app.inject({ method: 'GET', url: `/api/scenes/${s.scene.id}`, headers: as(s.admin) })
    expect(own.json().scene.presets).toHaveLength(4)
    expect(own.json().scene.collaborators).toHaveLength(1)
  })

  it('preset clone remaps parentInstanceId to the cloned parent', async () => {
    const s = await venueSetup()
    const parent = await createInstance(s.wall.id)
    const child = await createInstance(s.screen.id)
    await db.update(sceneElementInstances).set({ parentInstanceId: parent.id }).where(eq(sceneElementInstances.id, child.id))
    const { booking } = (await book(s, randomWallet())).json()
    const clones = await db.query.sceneElements.findMany({ where: eq(sceneElements.presetId, booking.bookingPresetId), with: { instances: true } })
    const insts = clones.flatMap((c) => c.instances)
    const cloneChildEl = clones.find((c) => c.clonedFromId === s.screen.id)!
    const cloneParentEl = clones.find((c) => c.clonedFromId === s.wall.id)!
    const cloneParent = cloneParentEl.instances[0]
    const withParent = cloneChildEl.instances.filter((i) => i.parentInstanceId)
    expect(withParent).toHaveLength(1)
    expect(withParent[0].parentInstanceId).toBe(cloneParent.id)
    expect(insts.some((i) => i.id === parent.id || i.id === child.id)).toBe(false)
  })
})
