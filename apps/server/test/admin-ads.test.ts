import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { db } from '../src/db/connection.js'
import { ads, adCreatives, adSpaceSettings, adEvents, mediaAssets, sceneElements, scenePresets } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { selectAdsForElements } from '../src/ads/select.js'
import { testApp, createUser, createScene, createElement, tokenFor } from './helpers/factories.js'

const FAKE = '00000000-0000-4000-8000-000000000001'

describe('admin ads routes', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let admin: Awaited<ReturnType<typeof createUser>>
  let h: { authorization: string }
  beforeEach(async () => {
    await resetDb()
    app = await testApp()
    admin = await createUser({ role: 'admin' })
    h = { authorization: `Bearer ${tokenFor(admin)}` }
  })
  afterEach(async () => { await app.close() })

  const call = (method: string, url: string, payload?: unknown, headers = h) => app.inject({ method: method as any, url, headers, payload: payload as any })
  const mkAd = async (kind: 'house' | 'partner' = 'partner') => (await call('POST', '/api/admin/ads', { name: 'Ad', kind, clickUrl: 'https://x.example' })).json().ad
  const mkMedia = (contentType: string, over: Record<string, unknown> = {}) =>
    db.insert(mediaAssets).values({ ownerId: admin.id, filename: 'f', contentType, sizeBytes: 10, storageKey: 'k', publicUrl: 'https://cdn.example/f', ...over }).returning().then((r) => r[0])

  it('non-admins get 403 on every admin ads route', async () => {
    const headers = { authorization: `Bearer ${tokenFor(await createUser({ role: 'creator' }))}` }
    const routes: [string, string, unknown?][] = [
      ['GET', '/api/admin/ads'],
      ['POST', '/api/admin/ads', { name: 'x', kind: 'house', clickUrl: 'https://x.example' }],
      ['PATCH', `/api/admin/ads/${FAKE}`, { status: 'paused' }],
      ['POST', `/api/admin/ads/${FAKE}/creatives`, { mediaAssetId: FAKE, shape: '1:1' }],
      ['DELETE', `/api/admin/ads/${FAKE}/creatives/${FAKE}`],
      ['PUT', `/api/admin/ads/${FAKE}/placements`, { elementIds: [] }],
      ['GET', '/api/admin/ads/spaces'],
      ['GET', `/api/admin/ads/${FAKE}/report`],
      ['POST', `/api/admin/ads/${FAKE}/review`, { decision: 'rejected', reason: 'x' }],
    ]
    for (const [m, u, b] of routes) expect((await call(m, u, b, headers)).statusCode, `${m} ${u}`).toBe(403)
  })

  const addCreative = async (adId: string, shape = '1:1') =>
    (await call('POST', `/api/admin/ads/${adId}/creatives`, { mediaAssetId: (await mkMedia('image/png')).id, shape })).json().creative
  const approve = (adId: string, audience: unknown = 'family') => call('POST', `/api/admin/ads/${adId}/review`, { decision: 'approved', audience })

  it('a new ad is pending and the queue lists it', async () => {
    const a = await mkAd()
    expect(a.review).toMatchObject({ status: 'pending', audience: null, reason: null })
    const b = await mkAd()
    await addCreative(b.id)
    await approve(b.id)
    const queue = (await call('GET', '/api/admin/ads?review=pending')).json().ads
    expect(queue.map((x: any) => x.id)).toEqual([a.id])
    expect((await call('GET', '/api/admin/ads')).json().ads).toHaveLength(2)
  })

  it('approve with a label, reject with a reason', async () => {
    const ad = await mkAd()
    expect((await approve(ad.id)).json().error).toBe('ad_has_no_creatives')
    await addCreative(ad.id)
    const ok = await approve(ad.id, 'mature')
    expect(ok.statusCode).toBe(200)
    expect(ok.json().ad.review).toMatchObject({ status: 'approved', audience: 'mature', reviewerKind: 'human' })
    expect(ok.json().ad.review.reviewedAt).toBeTruthy()
    for (const bad of [null, 'kids', 5]) {
      const r = await approve(ad.id, bad)
      expect(r.statusCode).toBe(400)
      expect(r.json().error).toBe('audience_required')
    }
    const noReason = await call('POST', `/api/admin/ads/${ad.id}/review`, { decision: 'rejected', reason: '  ' })
    expect(noReason.statusCode).toBe(400)
    expect(noReason.json().error).toBe('reason_required')
    expect((await call('POST', `/api/admin/ads/${ad.id}/review`, { decision: 'rejected' })).json().error).toBe('reason_required')
    const rej = await call('POST', `/api/admin/ads/${ad.id}/review`, { decision: 'rejected', reason: 'Too loud' })
    expect(rej.statusCode).toBe(200)
    expect(rej.json().ad.review).toMatchObject({ status: 'rejected', audience: null, reason: 'Too loud' })
    expect((await call('POST', `/api/admin/ads/${ad.id}/review`, { decision: 'maybe' })).statusCode).toBe(400)
    expect((await call('POST', `/api/admin/ads/${FAKE}/review`, { decision: 'rejected', reason: 'x' })).statusCode).toBe(404)
    expect((await call('POST', `/api/admin/ads/${FAKE}/review`, { decision: 'rejected', reason: 'x' })).json().error).toBe('Ad not found')
  })

  it('editing click url or creatives after approval sends the ad back to pending and stops it serving', async () => {
    const { scene, preset } = await createScene(admin)
    const space = await createElement(preset.id, { type: 'ad_space', properties: { shape: '1:1', formats: 'both' } })
    const ad = await mkAd('house')
    const c = await addCreative(ad.id)
    const serves = async () => (await selectAdsForElements(scene.id, [space.id], new Date()))[space.id]?.ads.length ?? 0
    const status = async () => (await call('GET', '/api/admin/ads')).json().ads[0].review.status
    expect(await serves()).toBe(0)
    await approve(ad.id)
    expect(await serves()).toBe(1)

    await call('PATCH', `/api/admin/ads/${ad.id}`, { name: 'New name', status: 'paused' })
    await call('PATCH', `/api/admin/ads/${ad.id}`, { status: 'active', clickUrl: 'https://x.example' })
    expect(await status()).toBe('approved')

    expect((await call('PATCH', `/api/admin/ads/${ad.id}`, { clickUrl: 'https://y.example' })).json().ad.review.status).toBe('pending')
    expect(await serves()).toBe(0)
    await approve(ad.id)
    expect(await serves()).toBe(1)

    await addCreative(ad.id, '16:9')
    expect(await status()).toBe('pending')
    await approve(ad.id)
    await call('DELETE', `/api/admin/ads/${ad.id}/creatives/${c.id}`)
    expect(await status()).toBe('pending')
    expect(await serves()).toBe(0)
  })

  it("spaces report each space's content setting, family by default", async () => {
    const { preset } = await createScene(admin)
    const a = await createElement(preset.id, { type: 'ad_space', properties: { shape: '1:1', formats: 'both' } })
    const b = await createElement(preset.id, { type: 'ad_space', properties: { shape: '1:1', formats: 'both' } })
    await db.insert(adSpaceSettings).values({ elementId: b.id, content: 'approve' })
    const by = Object.fromEntries((await call('GET', '/api/admin/ads/spaces')).json().spaces.map((s: any) => [s.elementId, s]))
    expect(by[a.id].content).toBe('family')
    expect(by[b.id].content).toBe('approve')
  })

  it('create, update, pause an ad', async () => {
    const created = await call('POST', '/api/admin/ads', { name: 'Launch', kind: 'partner', clickUrl: 'https://x.example', startsAt: '2026-11-01T00:00:00Z' })
    expect(created.statusCode).toBe(201)
    const ad = created.json().ad
    expect(ad).toMatchObject({ name: 'Launch', kind: 'partner', status: 'active', startsAt: '2026-11-01T00:00:00.000Z', endsAt: null, creatives: [], placements: [] })

    const patched = await call('PATCH', `/api/admin/ads/${ad.id}`, { name: 'Renamed', status: 'paused', endsAt: '2026-12-01T00:00:00Z', clickUrl: 'https://y.example' })
    expect(patched.json().ad).toMatchObject({ name: 'Renamed', status: 'paused', endsAt: '2026-12-01T00:00:00.000Z', clickUrl: 'https://y.example' })
    expect((await call('PATCH', `/api/admin/ads/${ad.id}`, { startsAt: null })).json().ad.startsAt).toBeNull()
    expect((await call('PATCH', `/api/admin/ads/${ad.id}`, { status: 'bogus' })).statusCode).toBe(400)
    expect((await call('PATCH', `/api/admin/ads/${FAKE}`, { status: 'paused' })).statusCode).toBe(404)

    const list = (await call('GET', '/api/admin/ads')).json().ads
    expect(list).toHaveLength(1)
    expect(list[0].status).toBe('paused')
  })

  it('attaching a creative takes its kind and url from the media asset and refuses non-image or non-video media', async () => {
    const ad = await mkAd()
    const img = await mkMedia('image/png')
    const vid = await mkMedia('video/mp4', { publicUrl: 'https://cdn.example/v.mp4' })
    const r1 = await call('POST', `/api/admin/ads/${ad.id}/creatives`, { mediaAssetId: img.id, shape: '1:1' })
    expect(r1.statusCode).toBe(201)
    expect(r1.json().creative).toMatchObject({ shape: '1:1', kind: 'image', url: 'https://cdn.example/f' })
    const r2 = await call('POST', `/api/admin/ads/${ad.id}/creatives`, { mediaAssetId: vid.id, shape: '16:9' })
    expect(r2.json().creative).toMatchObject({ kind: 'video', url: 'https://cdn.example/v.mp4' })

    expect((await call('POST', `/api/admin/ads/${ad.id}/creatives`, { mediaAssetId: (await mkMedia('application/pdf')).id, shape: '1:1' })).statusCode).toBe(400)
    expect((await call('POST', `/api/admin/ads/${ad.id}/creatives`, { mediaAssetId: (await mkMedia('image/png', { status: 'processing' })).id, shape: '1:1' })).statusCode).toBe(400)
    expect((await call('POST', `/api/admin/ads/${ad.id}/creatives`, { mediaAssetId: FAKE, shape: '1:1' })).statusCode).toBe(404)

    const shown = (await call('GET', '/api/admin/ads')).json().ads[0]
    expect(shown.creatives.map((c: any) => c.kind).sort()).toEqual(['image', 'video'])
    expect((await call('DELETE', `/api/admin/ads/${ad.id}/creatives/${r1.json().creative.id}`)).statusCode).toBe(200)
    expect((await call('DELETE', `/api/admin/ads/${ad.id}/creatives/${r1.json().creative.id}`)).statusCode).toBe(404)
    expect((await db.select().from(adCreatives))).toHaveLength(1)
  })

  it('rejects a non-https click url and an unknown shape', async () => {
    const bad = await call('POST', '/api/admin/ads', { name: 'x', kind: 'partner', clickUrl: 'http://x.example' })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error).toBe('click_url_must_be_https')
    expect((await call('POST', '/api/admin/ads', { name: 'x', kind: 'partner', clickUrl: 'javascript:alert(1)' })).json().error).toBe('click_url_must_be_https')
    expect((await call('POST', '/api/admin/ads', { name: 'x', kind: 'sponsor', clickUrl: 'https://x.example' })).statusCode).toBe(400)
    const ad = await mkAd()
    expect((await call('PATCH', `/api/admin/ads/${ad.id}`, { clickUrl: 'http://x.example' })).json().error).toBe('click_url_must_be_https')
    const img = await mkMedia('image/png')
    expect((await call('POST', `/api/admin/ads/${ad.id}/creatives`, { mediaAssetId: img.id, shape: '4:3' })).statusCode).toBe(400)
    expect(await db.select().from(ads)).toHaveLength(1)
  })

  it('placements only on partner ads and only on ad-capable elements', async () => {
    const { preset } = await createScene(admin)
    const space = await createElement(preset.id, { type: 'ad_space', properties: { shape: '1:1', formats: 'both' } })
    const adsVideo = await createElement(preset.id, { type: 'video', properties: { offType: 4 } })
    const plainVideo = await createElement(preset.id, { type: 'video', properties: { offType: 0 } })
    const image = await createElement(preset.id, { type: 'image', properties: {} })
    const partner = await mkAd('partner')
    const house = await mkAd('house')

    const ok = await call('PUT', `/api/admin/ads/${partner.id}/placements`, { elementIds: [space.id, adsVideo.id] })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().ad.placements.sort()).toEqual([space.id, adsVideo.id].sort())
    const replaced = await call('PUT', `/api/admin/ads/${partner.id}/placements`, { elementIds: [space.id] })
    expect(replaced.json().ad.placements).toEqual([space.id])

    const h1 = await call('PUT', `/api/admin/ads/${house.id}/placements`, { elementIds: [space.id] })
    expect(h1.statusCode).toBe(400)
    expect(h1.json().error).toBe('house_ads_go_everywhere')
    for (const bad of [plainVideo.id, image.id, FAKE]) {
      expect((await call('PUT', `/api/admin/ads/${partner.id}/placements`, { elementIds: [space.id, bad] })).statusCode).toBe(400)
    }
    expect((await call('GET', '/api/admin/ads')).json().ads.find((a: any) => a.id === partner.id).placements).toEqual([space.id])
  })

  it('spaces lists ad_space elements and video screens in ads modes', async () => {
    const { preset } = await createScene(admin, 'Ship')
    const space = await createElement(preset.id, { type: 'ad_space', name: 'Banner', properties: { shape: '2:5', formats: 'both' } })
    const screen = await createElement(preset.id, { type: 'video', name: 'Screen', properties: { offType: 5, adShape: '1:1' } })
    const defaultShape = await createElement(preset.id, { type: 'video', name: 'Screen 2', properties: { offType: 4 } })
    await createElement(preset.id, { type: 'video', name: 'Plain', properties: { offType: 0 } })
    await createElement(preset.id, { type: 'image', name: 'Pic', properties: {} })
    const res = await call('GET', '/api/admin/ads/spaces')
    expect(res.statusCode).toBe(200)
    const spaces = res.json().spaces
    expect(spaces).toHaveLength(3)
    const by = Object.fromEntries(spaces.map((s: any) => [s.elementId, s]))
    expect(by[space.id]).toMatchObject({ sceneName: 'Ship', name: 'Banner', type: 'ad_space', shape: '2:5' })
    expect(by[screen.id]).toMatchObject({ type: 'video', shape: '1:1' })
    expect(by[defaultShape.id].shape).toBe('16:9')
  })

  it('spaces leaves out booking clones and names each preset, marking the active one', async () => {
    const { scene, preset } = await createScene(admin, 'Ship')
    const live = await createElement(preset.id, { type: 'ad_space', name: 'Banner', properties: { shape: '1:1', formats: 'both' } })
    const [other] = await db.insert(scenePresets).values({ sceneId: scene.id, name: 'Night' }).returning()
    const night = await createElement(other.id, { type: 'ad_space', name: 'Banner', properties: { shape: '1:1', formats: 'both' } })
    const [booking] = await db.insert(scenePresets).values({ sceneId: scene.id, name: 'Booking' }).returning()
    await db.insert(sceneElements).values({ presetId: booking.id, type: 'ad_space', name: 'Banner', properties: { shape: '1:1', formats: 'both' }, clonedFromId: live.id })
    const spaces = (await call('GET', '/api/admin/ads/spaces')).json().spaces
    expect(spaces.map((s: any) => s.elementId).sort()).toEqual([live.id, night.id].sort())
    const by = Object.fromEntries(spaces.map((s: any) => [s.elementId, s]))
    expect(by[live.id]).toMatchObject({ presetName: 'Default', activePreset: true })
    expect(by[night.id]).toMatchObject({ presetName: 'Night', activePreset: false })
  })

  it('report splits verified and unverified counts by day and by space; totals count each viewer once per day', async () => {
    const { scene, preset } = await createScene(admin, 'Ship')
    const e1 = await createElement(preset.id, { type: 'ad_space', properties: { shape: '1:1' } })
    const e2 = await createElement(preset.id, { type: 'ad_space', properties: { shape: '1:1' } })
    const ad = await mkAd()
    const ev = (elementId: string, level: string, day: string, viewerKey: string, verified: boolean, dwellMs?: number) =>
      ({ adId: ad.id, elementId, sceneId: scene.id, level, day, viewerKey, verified, house: false, dwellMs: dwellMs ?? null, occurredAt: new Date(`${day}T12:00:00Z`) })
    await db.insert(adEvents).values([
      ev(e1.id, 'scene', '2026-10-18', 'w:a', true),
      ev(e1.id, 'screen', '2026-10-18', 'w:a', true),
      ev(e1.id, 'look', '2026-10-18', 'w:a', true, 3000),
      ev(e1.id, 'click', '2026-10-18', 'w:a', true),
      ev(e1.id, 'scene', '2026-10-19', 'w:b', true),
      ev(e1.id, 'look', '2026-10-19', 'w:b', true, 5000),
      ev(e2.id, 'scene', '2026-10-19', 'w:a', true),
      ev(e2.id, 'scene', '2026-10-19', 'w:b', true), // w:b saw it on both spaces that day
      ev(e2.id, 'scene', '2026-10-19', 'u:g1', false),
      ev(e2.id, 'click', '2026-10-19', 'u:g1', false),
      ev(e2.id, 'look', '2026-10-19', 'u:g1', false, 90000),
    ])
    const res = await call('GET', `/api/admin/ads/${ad.id}/report`)
    expect(res.statusCode).toBe(200)
    const r = res.json()
    const zero = { scene: 0, screen: 0, look: 0, click: 0 }
    expect(r.totals).toEqual({ scene: 3, screen: 1, look: 2, click: 1, unverified: { scene: 1, screen: 0, look: 1, click: 1 } })
    expect(r.byDay).toEqual([
      { day: '2026-10-18', scene: 1, screen: 1, look: 1, click: 1, unverified: zero },
      { day: '2026-10-19', scene: 2, screen: 0, look: 1, click: 0, unverified: { scene: 1, screen: 0, look: 1, click: 1 } },
    ])
    expect(r.bySpace).toHaveLength(2)
    const by = Object.fromEntries(r.bySpace.map((s: any) => [s.elementId, s]))
    expect(by[e1.id]).toEqual({ elementId: e1.id, sceneName: 'Ship', scene: 2, screen: 1, look: 2, click: 1, unverified: zero })
    expect(by[e2.id]).toMatchObject({ scene: 2, unverified: { scene: 1, screen: 0, look: 1, click: 1 } })
    expect(r.avgLookMs).toBe(4000)

    const empty = await mkAd()
    expect((await call('GET', `/api/admin/ads/${empty.id}/report`)).json()).toEqual({
      totals: { ...zero, unverified: zero }, byDay: [], bySpace: [], avgLookMs: null,
    })
    expect((await call('GET', `/api/admin/ads/${FAKE}/report`)).statusCode).toBe(404)
  })
})
