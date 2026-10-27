import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../src/db/connection.js'
import { ads, adCreatives, adPlacements, venues, bookings, sceneElements } from '../src/db/schema.js'
import { DEFAULT_VENUE_RULES } from '@virvixr/shared'
import { selectAdsForElements } from '../src/ads/select.js'
import { resetDb } from './helpers/db.js'
import { createUser, createScene, createElement } from './helpers/factories.js'

const NOW = new Date('2026-10-19T12:00:00Z')
const H = 3_600_000

async function seed() {
  const owner = await createUser()
  const { scene, preset } = await createScene(owner)
  return { scene, preset }
}

async function mkAd(
  kind: 'house' | 'partner',
  creatives: Array<{ shape: string; kind: 'image' | 'video' }>,
  over: Partial<typeof ads.$inferInsert> = {},
) {
  const [ad] = await db.insert(ads).values({ name: 'A', kind, clickUrl: 'https://x.example', ...over }).returning()
  const cs = []
  for (const c of creatives) {
    const [row] = await db.insert(adCreatives).values({ adId: ad.id, shape: c.shape, kind: c.kind, url: `https://cdn.example/${crypto.randomUUID()}` }).returning()
    cs.push(row)
  }
  return { ad, cs }
}

const space = (presetId: string, props: Record<string, unknown>) => createElement(presetId, { type: 'ad_space', properties: props })

describe('selectAdsForElements', () => {
  beforeEach(async () => { await resetDb() })

  it("returns only creatives in the space's shape", async () => {
    const { scene, preset } = await seed()
    const el = await space(preset.id, { shape: '1:1', formats: 'both' })
    const { cs } = await mkAd('house', [{ shape: '1:1', kind: 'image' }, { shape: '16:9', kind: 'image' }])
    const out = await selectAdsForElements(scene.id, [el.id], NOW)
    expect(out[el.id].paused).toBe(false)
    expect(out[el.id].ads.map((a) => a.creativeId)).toEqual([cs[0].id])
  })

  it('formats image excludes video creatives and video excludes images', async () => {
    const { scene, preset } = await seed()
    const img = await space(preset.id, { shape: '16:9', formats: 'image' })
    const vid = await space(preset.id, { shape: '16:9', formats: 'video' })
    await mkAd('house', [{ shape: '16:9', kind: 'image' }, { shape: '16:9', kind: 'video' }])
    const out = await selectAdsForElements(scene.id, [img.id, vid.id], NOW)
    expect(out[img.id].ads.map((a) => a.kind)).toEqual(['image'])
    expect(out[vid.id].ads.map((a) => a.kind)).toEqual(['video'])
  })

  it('a video screen in ads mode is a 16:9 space with both formats, and other video modes are skipped', async () => {
    const { scene, preset } = await seed()
    const adsMode = await createElement(preset.id, { type: 'video', properties: { offType: 4 } })
    const playlistAds = await createElement(preset.id, { type: 'video', properties: { offType: 5, adShape: '9:16' } })
    const other = await createElement(preset.id, { type: 'video', properties: { offType: 1 } })
    await mkAd('house', [{ shape: '16:9', kind: 'video' }, { shape: '16:9', kind: 'image' }, { shape: '9:16', kind: 'image' }])
    const out = await selectAdsForElements(scene.id, [adsMode.id, playlistAds.id, other.id], NOW)
    expect(out[adsMode.id].ads.map((a) => a.kind).sort()).toEqual(['image', 'video'])
    expect(out[playlistAds.id].ads.map((a) => a.kind)).toEqual(['image'])
    expect(other.id in out).toBe(false)
  })

  it('partner ads placed on the element win over house ads', async () => {
    const { scene, preset } = await seed()
    const el = await space(preset.id, { shape: '1:1', formats: 'both' })
    await mkAd('house', [{ shape: '1:1', kind: 'image' }])
    const partner = await mkAd('partner', [{ shape: '1:1', kind: 'image' }])
    await mkAd('partner', [{ shape: '1:1', kind: 'image' }]) // not placed
    await db.insert(adPlacements).values({ adId: partner.ad.id, elementId: el.id })
    const out = await selectAdsForElements(scene.id, [el.id], NOW)
    expect(out[el.id].ads).toEqual([
      { adId: partner.ad.id, creativeId: partner.cs[0].id, kind: 'image', url: partner.cs[0].url, clickUrl: 'https://x.example', house: false },
    ])
  })

  it('house ads fill a space with no partner placement', async () => {
    const { scene, preset } = await seed()
    const el = await space(preset.id, { shape: '1:1', formats: 'both' })
    const a = await mkAd('house', [{ shape: '1:1', kind: 'image' }])
    const b = await mkAd('house', [{ shape: '1:1', kind: 'video' }])
    const partner = await mkAd('partner', [{ shape: '16:9', kind: 'image' }]) // placed, but no creative in shape
    await db.insert(adPlacements).values({ adId: partner.ad.id, elementId: el.id })
    const out = await selectAdsForElements(scene.id, [el.id], NOW)
    const items = out[el.id].ads
    expect(items.every((i) => i.house)).toBe(true)
    expect(items.map((i) => i.adId)).toEqual([a.ad.id, b.ad.id].sort())
  })

  it('paused and out-of-date ads are excluded', async () => {
    const { scene, preset } = await seed()
    const el = await space(preset.id, { shape: '1:1', formats: 'both' })
    const c = [{ shape: '1:1', kind: 'image' as const }]
    await mkAd('house', c, { status: 'paused' })
    await mkAd('house', c, { startsAt: new Date(NOW.getTime() + H) })
    await mkAd('house', c, { endsAt: NOW })
    const ok = await mkAd('house', c, { startsAt: NOW, endsAt: new Date(NOW.getTime() + H) })
    const open = await mkAd('house', c)
    const out = await selectAdsForElements(scene.id, [el.id], NOW)
    expect(out[el.id].ads.map((a) => a.adId).sort()).toEqual([ok.ad.id, open.ad.id].sort())
  })

  async function venueWith(sceneId: string, presetId: string, rentable: string[], b: { status?: 'confirmed' | 'live' | 'pending'; start: Date; end: Date }) {
    const owner = await createUser()
    const [venue] = await db.insert(venues).values({
      sceneId, name: 'V', slug: `v-${crypto.randomUUID()}`, defaultPresetId: presetId, rules: DEFAULT_VENUE_RULES, rentableElementIds: rentable,
    }).returning()
    await db.insert(bookings).values({
      venueId: venue.id, renterUserId: owner.id, title: 'Show', startsAt: b.start, endsAt: b.end,
      status: b.status ?? 'confirmed', blockedRange: `[${b.start.toISOString()},${b.end.toISOString()})`,
    })
  }

  it('an element under an active venue booking is paused', async () => {
    const { scene, preset } = await seed()
    const el = await space(preset.id, { shape: '1:1', formats: 'both' })
    const other = await space(preset.id, { shape: '1:1', formats: 'both' })
    await mkAd('house', [{ shape: '1:1', kind: 'image' }])
    await venueWith(scene.id, preset.id, [el.id], { start: new Date(NOW.getTime() - H), end: new Date(NOW.getTime() + H) })
    const out = await selectAdsForElements(scene.id, [el.id, other.id], NOW)
    expect(out[el.id]).toEqual({ paused: true, ads: [] })
    expect(out[other.id].ads).toHaveLength(1)
    // ignoreBooking skips the pause
    const ignored = await selectAdsForElements(scene.id, [el.id], NOW, { ignoreBooking: true })
    expect(ignored[el.id].paused).toBe(false)
    expect(ignored[el.id].ads).toHaveLength(1)
    // outside the window it is not paused
    const later = await selectAdsForElements(scene.id, [el.id], new Date(NOW.getTime() + H))
    expect(later[el.id].paused).toBe(false)
  })

  it('a pending booking does not pause', async () => {
    const { scene, preset } = await seed()
    const el = await space(preset.id, { shape: '1:1', formats: 'both' })
    await venueWith(scene.id, preset.id, [el.id], { status: 'pending', start: new Date(NOW.getTime() - H), end: new Date(NOW.getTime() + H) })
    const out = await selectAdsForElements(scene.id, [el.id], NOW)
    expect(out[el.id].paused).toBe(false)
  })

  it('a placement on the original element applies to its booking-preset clone', async () => {
    const { scene, preset } = await seed()
    const original = await space(preset.id, { shape: '1:1', formats: 'both' })
    const [clone] = await db.insert(sceneElements).values({
      presetId: preset.id, type: 'ad_space', name: 'clone', properties: { shape: '1:1', formats: 'both' }, clonedFromId: original.id,
    }).returning()
    await mkAd('house', [{ shape: '1:1', kind: 'image' }])
    const partner = await mkAd('partner', [{ shape: '1:1', kind: 'image' }])
    await db.insert(adPlacements).values({ adId: partner.ad.id, elementId: original.id })
    const out = await selectAdsForElements(scene.id, [clone.id], NOW)
    expect(out[clone.id].ads.map((a) => a.adId)).toEqual([partner.ad.id])
    // and a booking on the original pauses the clone
    await venueWith(scene.id, preset.id, [original.id], { start: new Date(NOW.getTime() - H), end: new Date(NOW.getTime() + H) })
    const paused = await selectAdsForElements(scene.id, [clone.id], NOW)
    expect(paused[clone.id].paused).toBe(true)
  })
})
