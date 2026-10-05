import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { sceneElements, sceneElementInstances, sceneCollaborators } from '../src/db/schema.js'
import { createVenue, createBooking, addGrant, revokeGrant } from '../src/venues/service.js'
import { resetDb } from './helpers/db.js'
import { createUser, createScene, createElement, tokenFor, expiredTokenFor, randomWallet } from './helpers/factories.js'
import { startGameServer, joinScene, serverRoom } from './helpers/game-server.js'

const H = 3600_000
const update = (id: string, props: Record<string, unknown>) => ({
  action: 'update',
  element: 'video',
  elementData: { sk: id, ...props },
})
const propsOf = async (id: string) =>
  (await db.query.sceneElements.findFirst({ where: eq(sceneElements.id, id) }))!.properties as Record<string, unknown>

describe('VLMSceneRoom auth', () => {
  let gs: Awaited<ReturnType<typeof startGameServer>>
  beforeEach(async () => {
    await resetDb()
    gs = await startGameServer()
  })
  afterEach(() => gs.stop())

  async function scene() {
    const owner = await createUser()
    const { scene, preset } = await createScene(owner)
    const screen = await createElement(preset.id)
    return { owner, scene, preset, screen }
  }

  it('anonymous visitor receives init but cannot mutate', async () => {
    const s = await scene()
    const watcher = await joinScene(gs.url, s.scene.id, tokenFor(s.owner))
    await watcher.waitFor('scene_preset_update') // consume init
    const anon = await joinScene(gs.url, s.scene.id)
    expect((await anon.waitFor('auth_status')).authenticated).toBe(false)
    expect((await anon.waitFor('scene_preset_update')).action).toBe('init')

    anon.room.send('scene_preset_update', update(s.screen.id, { liveSrc: 'https://evil/x.m3u8' }))
    expect((await anon.waitFor('vlm_error')).code).toBe('forbidden')
    await watcher.expectNone('scene_preset_update')
    expect((await propsOf(s.screen.id)).liveSrc).toBe('https://old.example/live.m3u8')
  })

  it('owner can mutate; others in the room see the broadcast', async () => {
    const s = await scene()
    const owner = await joinScene(gs.url, s.scene.id, tokenFor(s.owner))
    const visitor = await joinScene(gs.url, s.scene.id)
    await visitor.waitFor('scene_preset_update') // init
    owner.room.send('scene_preset_update', update(s.screen.id, { liveSrc: 'https://new/live.m3u8', playlist: [] }))
    expect((await visitor.waitFor('scene_preset_update')).elementData.liveSrc).toBe('https://new/live.m3u8')
    expect((await propsOf(s.screen.id)).liveSrc).toBe('https://new/live.m3u8')
  })

  it('expired token joins as anonymous and is told so', async () => {
    const s = await scene()
    const c = await joinScene(gs.url, s.scene.id, expiredTokenFor(s.owner))
    expect((await c.waitFor('auth_status')).authenticated).toBe(false)
    c.room.send('scene_change_preset', { presetId: s.preset.id })
    expect((await c.waitFor('vlm_error')).code).toBe('forbidden')
  })

  it('owner of scene A cannot edit scene B elements through room A', async () => {
    const a = await scene()
    const b = await scene()
    await db.insert(sceneCollaborators).values({ sceneId: a.scene.id, userId: b.owner.id, role: 'editor' })
    const c = await joinScene(gs.url, a.scene.id, tokenFor(b.owner))
    c.room.send('scene_preset_update', update(b.screen.id, { liveSrc: 'x' }))
    expect((await c.waitFor('vlm_error')).code).toBe('not_found')
  })

  it('instance create cannot be redirected to another scene element', async () => {
    const a = await scene()
    const b = await scene()
    const c = await joinScene(gs.url, a.scene.id, tokenFor(a.owner))
    await c.waitFor('scene_preset_update') // init
    c.room.send('scene_preset_update', {
      action: 'create',
      element: 'video',
      instance: true,
      instanceData: { elementId: a.screen.id, position: { x: 2, y: 2, z: 2 } },
      elementData: { sk: b.screen.id },
    })
    for (let i = 0; i < 150 && !c.inbox.some((m) => m.type === 'scene_preset_update_ack' || m.type === 'vlm_error'); i++) {
      await new Promise((r) => setTimeout(r, 20))
    }
    const underB = await db.select().from(sceneElementInstances).where(eq(sceneElementInstances.elementId, b.screen.id))
    expect(underB).toHaveLength(0)
  })

  it('different scenes get different rooms', async () => {
    const a = await scene()
    const b = await scene()
    const ca = await joinScene(gs.url, a.scene.id)
    const cb = await joinScene(gs.url, b.scene.id)
    expect(ca.room.roomId).not.toBe(cb.room.roomId)
  })

  describe('venue grants', () => {
    async function venueWithCrew(startInMs = 24 * H) {
      const admin = await createUser({ role: 'admin' })
      const { scene, preset } = await createScene(admin)
      const screen = await createElement(preset.id)
      const venue = await createVenue({ sceneId: scene.id, name: 'Aurora', slug: `aurora-${crypto.randomUUID()}`, rentableElementIds: [screen.id] })
      const hostWallet = randomWallet()
      const host = await createUser({ wallet: hostWallet })
      const startsAt = new Date(Date.now() + startInMs)
      const { booking } = await createBooking({
        venueId: venue.id,
        renterWallet: hostWallet,
        title: 'Set',
        startsAt,
        endsAt: new Date(startsAt.getTime() + 2 * H),
        createdByUserId: admin.id,
      })
      const crewWallet = randomWallet()
      const crew = await createUser({ wallet: crewWallet })
      const grant = await addGrant({ bookingId: booking.id, walletAddress: crewWallet, role: 'vj', grantedByUserId: host.id })
      const [clone] = await db.select().from(sceneElements).where(eq(sceneElements.presetId, booking.bookingPresetId!))
      return { admin, scene, preset, screen, venue, booking, host, crew, grant, clone }
    }

    it('crew gets venue_access on join', async () => {
      const v = await venueWithCrew()
      const c = await joinScene(gs.url, v.scene.id, tokenFor(v.crew))
      const access = await c.waitFor('venue_access')
      expect(access).toMatchObject({ bookingId: v.booking.id, role: 'vj', window: 'setup' })
      expect(access.scopes.sort()).toEqual(['playlist', 'schedule', 'screens'])
    })

    it('in setup, crew edits the booking clone without broadcasting to the live scene', async () => {
      const v = await venueWithCrew()
      const visitor = await joinScene(gs.url, v.scene.id)
      await visitor.waitFor('scene_preset_update') // init
      const c = await joinScene(gs.url, v.scene.id, tokenFor(v.crew))
      c.room.send('scene_preset_update', update(v.clone.id, { ...(v.clone.properties as object), liveSrc: 'https://dj/live.m3u8' }))
      await c.waitFor('scene_preset_update_ack')
      await visitor.expectNone('scene_preset_update')
      expect((await propsOf(v.clone.id)).liveSrc).toBe('https://dj/live.m3u8')
      expect((await propsOf(v.screen.id)).liveSrc).toBe('https://old.example/live.m3u8')
    })

    it('crew cannot edit the live default preset element', async () => {
      const v = await venueWithCrew()
      const c = await joinScene(gs.url, v.scene.id, tokenFor(v.crew))
      c.room.send('scene_preset_update', update(v.screen.id, { liveSrc: 'x' }))
      expect((await c.waitFor('vlm_error')).code).toBe('forbidden')
    })

    it('crew without moderation cannot send moderator messages', async () => {
      const v = await venueWithCrew()
      const c = await joinScene(gs.url, v.scene.id, tokenFor(v.crew))
      c.room.send('scene_moderator_message', { message: 'hi' })
      expect((await c.waitFor('vlm_error')).code).toBe('forbidden')
    })

    it('revoking a grant takes effect on the very next message and notifies the client', async () => {
      const v = await venueWithCrew()
      const c = await joinScene(gs.url, v.scene.id, tokenFor(v.crew))
      await c.waitFor('venue_access')
      // warm the 10-second cache
      c.room.send('scene_preset_update', update(v.clone.id, { ...(v.clone.properties as object), liveSrc: 'a' }))
      await c.waitFor('scene_preset_update_ack')
      await revokeGrant(v.grant.id)
      expect((await c.waitFor('access_revoked')).reason).toBe('revoked')
      c.room.send('scene_preset_update', update(v.clone.id, { liveSrc: 'b' }))
      expect((await c.waitFor('vlm_error')).code).toBe('forbidden')
    })

    it('an access lookup in flight during a revoke does not repopulate the cache', async () => {
      const v = await venueWithCrew()
      const c = await joinScene(gs.url, v.scene.id, tokenFor(v.crew))
      await c.waitFor('venue_access')
      const room = serverRoom(c.room.roomId)
      room.accessCache.clear() // cold cache

      // Gate the next lookup: it reads pre-revoke access, then stalls until released.
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      let lookedUp!: () => void
      const looked = new Promise<void>((r) => (lookedUp = r))
      const original = room.lookupAccess.bind(room)
      let first = true
      room.lookupAccess = async (actor: unknown) => {
        const result = await original(actor)
        if (first) {
          first = false
          lookedUp()
          await gate
        }
        return result
      }

      c.room.send('scene_preset_update', update(v.clone.id, { ...(v.clone.properties as object), liveSrc: 'a' }))
      await looked
      await revokeGrant(v.grant.id)
      expect((await c.waitFor('access_revoked')).reason).toBe('revoked')
      release()
      await c.waitFor('scene_preset_update_ack') // the in-flight call may use its (stale) result once

      c.room.send('scene_preset_update', update(v.clone.id, { liveSrc: 'b' }))
      expect((await c.waitFor('vlm_error')).code).toBe('forbidden')
    })
  })
})
