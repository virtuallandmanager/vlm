import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { bookings, scenes, scenePresets } from '../src/db/schema.js'
import { createVenue, createBooking, addGrant } from '../src/venues/service.js'
import { runLifecycleSweep } from '../src/venues/lifecycle.js'
import { initBus } from '../src/realtime/bus.js'
import { resetDb } from './helpers/db.js'
import { createUser, createScene, createElement, tokenFor, randomWallet } from './helpers/factories.js'
import { startGameServer, joinScene } from './helpers/game-server.js'

const H = 3600_000
const M = 60_000

async function seed() {
  const admin = await createUser({ role: 'admin' })
  const { scene, preset } = await createScene(admin)
  const screen = await createElement(preset.id)
  const venue = await createVenue({ sceneId: scene.id, name: 'Caldera', slug: `c-${crypto.randomUUID()}`, rentableElementIds: [screen.id] })
  const hostWallet = randomWallet()
  const host = await createUser({ wallet: hostWallet })
  const startsAt = new Date(Date.now() + 3 * H)
  const { booking } = await createBooking({
    venueId: venue.id,
    renterWallet: hostWallet,
    title: 'Set',
    startsAt,
    endsAt: new Date(startsAt.getTime() + 2 * H),
    createdByUserId: admin.id,
  })
  return { admin, scene, preset, venue, host, booking }
}

const activePreset = async (sceneId: string) => (await db.query.scenes.findFirst({ where: eq(scenes.id, sceneId) }))!.activePresetId
const statusOf = async (id: string) => (await db.query.bookings.findFirst({ where: eq(bookings.id, id) }))!.status

describe('runLifecycleSweep', () => {
  const published: any[] = []
  beforeEach(async () => {
    await resetDb()
    published.length = 0
    initBus({ publish: (_t: string, e: unknown) => void published.push(e) })
  })

  it('does nothing before the live window', async () => {
    const s = await seed()
    const r = await runLifecycleSweep(new Date(s.booking.startsAt.getTime() - 61 * M))
    expect(r.wentLive).toEqual([])
    expect(await activePreset(s.scene.id)).toBe(s.preset.id)
  })

  it('goes live at startsAt − setupLead and swaps in the booking preset', async () => {
    const s = await seed()
    const r = await runLifecycleSweep(new Date(s.booking.startsAt.getTime() - 60 * M))
    expect(r.wentLive).toEqual([s.booking.id])
    expect(await statusOf(s.booking.id)).toBe('live')
    expect(await activePreset(s.scene.id)).toBe(s.booking.bookingPresetId)
    expect(published).toEqual(
      expect.arrayContaining([
        { type: 'preset_changed', sceneId: s.scene.id, presetId: s.booking.bookingPresetId },
        { type: 'grants_changed', sceneId: s.scene.id },
      ]),
    )
  })

  it('ends at endsAt + grace and reverts to the default preset', async () => {
    const s = await seed()
    await runLifecycleSweep(new Date(s.booking.startsAt.getTime() - 60 * M))
    published.length = 0
    const r = await runLifecycleSweep(new Date(s.booking.endsAt.getTime() + 15 * M))
    expect(r.ended).toEqual([s.booking.id])
    expect(await statusOf(s.booking.id)).toBe('ended')
    expect(await activePreset(s.scene.id)).toBe(s.preset.id)
    expect(published).toEqual(
      expect.arrayContaining([{ type: 'booking_ended', sceneId: s.scene.id, bookingId: s.booking.id, reason: 'expired' }]),
    )
  })

  it('a booking that was never swept live still ends cleanly', async () => {
    const s = await seed()
    const r = await runLifecycleSweep(new Date(s.booking.endsAt.getTime() + 20 * M))
    expect(r).toMatchObject({ wentLive: [], ended: [s.booking.id] })
    expect(await activePreset(s.scene.id)).toBe(s.preset.id)
  })

  it('is idempotent: concurrent sweeps (two servers) apply each transition once', async () => {
    const s = await seed()
    const at = new Date(s.booking.startsAt.getTime() - 30 * M)
    const [a, b] = await Promise.all([runLifecycleSweep(at), runLifecycleSweep(at)])
    expect([...a.wentLive, ...b.wentLive]).toEqual([s.booking.id])
    expect(published.filter((e) => e.type === 'preset_changed')).toHaveLength(1)
    published.length = 0
    expect(await runLifecycleSweep(at)).toMatchObject({ wentLive: [], ended: [] })
    expect(published).toEqual([])
  })

  it('deletes booking presets 30 days after the booking ends', async () => {
    const s = await seed()
    await runLifecycleSweep(new Date(s.booking.endsAt.getTime() + 15 * M))
    expect(await db.query.scenePresets.findFirst({ where: eq(scenePresets.id, s.booking.bookingPresetId!) })).toBeTruthy()
    const r = await runLifecycleSweep(new Date(s.booking.endsAt.getTime() + 31 * 24 * H))
    expect(r.purgedPresets).toBe(1)
    expect(await db.query.scenePresets.findFirst({ where: eq(scenePresets.id, s.booking.bookingPresetId!) })).toBeUndefined()
    expect((await db.query.bookings.findFirst({ where: eq(bookings.id, s.booking.id) }))!.bookingPresetId).toBeNull()
  })

  it('does not revert if the owner already switched presets away from the booking', async () => {
    const s = await seed()
    await runLifecycleSweep(new Date(s.booking.startsAt.getTime() - 60 * M))
    const other = (await createScene(s.admin, 'x')).preset // a different preset id
    await db.update(scenes).set({ activePresetId: other.id }).where(eq(scenes.id, s.scene.id))
    await runLifecycleSweep(new Date(s.booking.endsAt.getTime() + 15 * M))
    expect(await activePreset(s.scene.id)).toBe(other.id)
  })
})

describe('lifecycle reaches connected clients', () => {
  let gs: Awaited<ReturnType<typeof startGameServer>>
  beforeEach(async () => {
    await resetDb()
    gs = await startGameServer()
  })
  afterEach(() => gs.stop())

  it('crew sees the preset swap at go-live and access_revoked at the end', async () => {
    const s = await seed()
    const crewWallet = randomWallet()
    const crew = await createUser({ wallet: crewWallet })
    await addGrant({ bookingId: s.booking.id, walletAddress: crewWallet, role: 'vj', grantedByUserId: s.host.id })
    const c = await joinScene(gs.url, s.scene.id, tokenFor(crew))
    await c.waitFor('venue_access')

    await runLifecycleSweep(new Date(s.booking.startsAt.getTime() - 60 * M))
    expect((await c.waitFor('scene_change_preset')).scenePreset).toBeTruthy()

    // Real clock is still before the booking, so the grant is valid but in setup;
    // ending the booking flips status and the room must revoke.
    await runLifecycleSweep(new Date(s.booking.endsAt.getTime() + 15 * M))
    expect((await c.waitFor('access_revoked')).reason).toBe('expired')
    c.room.send('scene_video_update', { sk: 'x', isLive: true })
    expect((await c.waitFor('vlm_error')).code).toBe('forbidden')
  })
})
