import { describe, it, expect, beforeEach } from 'vitest'
import { VENUE_SCOPES, VENUE_ROLES, DEFAULT_VENUE_RULES } from 'vlm-shared'
import { db } from '../src/db/connection.js'
import { venues, bookings, accessGrants, venueScopeEnum, venueRoleEnum } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { createUser, createScene } from './helpers/factories.js'

const H = 3600_000
const range = (s: Date, e: Date) => `[${s.toISOString()},${e.toISOString()})`

async function seedVenue() {
  const owner = await createUser({ role: 'admin' })
  const { scene, preset } = await createScene(owner)
  const [venue] = await db
    .insert(venues)
    .values({ sceneId: scene.id, name: 'Caldera', slug: `caldera-${Date.now()}`, defaultPresetId: preset.id, rules: DEFAULT_VENUE_RULES })
    .returning()
  return { owner, scene, preset, venue }
}

function bookingValues(venueId: string, renterUserId: string, start: Date, end: Date, status: 'confirmed' | 'canceled' = 'confirmed') {
  const buf = DEFAULT_VENUE_RULES.bufferMinutes * 60_000
  return {
    venueId,
    renterUserId,
    title: 'Show',
    startsAt: start,
    endsAt: end,
    status,
    blockedRange: range(new Date(start.getTime() - buf), new Date(end.getTime() + buf)),
  }
}

describe('venue schema', () => {
  beforeEach(resetDb)

  it('DB enums match vlm-shared constants', () => {
    expect(venueScopeEnum.enumValues).toEqual([...VENUE_SCOPES])
    expect(venueRoleEnum.enumValues).toEqual([...VENUE_ROLES])
  })

  it('rejects overlapping active bookings, including the buffer', async () => {
    const { owner, venue } = await seedVenue()
    const t0 = new Date(Date.now() + 48 * H)
    await db.insert(bookings).values(bookingValues(venue.id, owner.id, t0, new Date(t0.getTime() + 2 * H)))
    // starts 20 minutes after the first ends: inside the 30-minute buffer
    const s2 = new Date(t0.getTime() + 2 * H + 20 * 60_000)
    await expect(
      db.insert(bookings).values(bookingValues(venue.id, owner.id, s2, new Date(s2.getTime() + H))),
    ).rejects.toMatchObject({ code: '23P01' })
  })

  it('allows bookings separated by more than both buffers', async () => {
    const { owner, venue } = await seedVenue()
    const t0 = new Date(Date.now() + 48 * H)
    await db.insert(bookings).values(bookingValues(venue.id, owner.id, t0, new Date(t0.getTime() + 2 * H)))
    const s2 = new Date(t0.getTime() + 3 * H + 1)
    await db.insert(bookings).values(bookingValues(venue.id, owner.id, s2, new Date(s2.getTime() + H)))
  })

  it('canceled bookings do not block a slot', async () => {
    const { owner, venue } = await seedVenue()
    const t0 = new Date(Date.now() + 48 * H)
    await db.insert(bookings).values(bookingValues(venue.id, owner.id, t0, new Date(t0.getTime() + 2 * H), 'canceled'))
    await db.insert(bookings).values(bookingValues(venue.id, owner.id, t0, new Date(t0.getTime() + 2 * H)))
  })

  it('a grant needs a wallet or a user', async () => {
    const { owner, scene, venue } = await seedVenue()
    const t0 = new Date(Date.now() + 48 * H)
    const [b] = await db.insert(bookings).values(bookingValues(venue.id, owner.id, t0, new Date(t0.getTime() + H))).returning()
    await expect(
      db.insert(accessGrants).values({
        bookingId: b.id,
        sceneId: scene.id,
        role: 'vj',
        scopes: ['screens'],
        validFrom: new Date(),
        validUntil: t0,
      }),
    ).rejects.toMatchObject({ code: '23514' })
  })
})
