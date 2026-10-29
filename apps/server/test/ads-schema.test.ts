import { describe, it, expect, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { ads, adEvents, adSpaceSettings, adSpaceApprovals, sceneElements } from '../src/db/schema.js'
import { serializePreset } from '../src/services/scene-serializer.js'
import { scopesForElementChange } from '../src/auth/permissions.js'
import { resetDb } from './helpers/db.js'
import { createUser, createScene, createElement, tokenFor, testApp } from './helpers/factories.js'

describe('ad spaces schema and plumbing', () => {
  beforeEach(async () => { await resetDb() })

  it('an ad_space element round-trips through POST /api/presets/:id/elements and appears in the serialized preset under adSpaces', async () => {
    const owner = await createUser()
    const { preset } = await createScene(owner)
    const app = await testApp()
    const res = await app.inject({
      method: 'POST',
      url: `/api/presets/${preset.id}/elements`,
      headers: { authorization: `Bearer ${tokenFor(owner)}` },
      payload: { type: 'ad_space', name: 'Lobby Ad', properties: { shape: '2:5', formats: 'both' } },
    })
    expect(res.statusCode).toBe(201)
    const { element } = res.json()
    const loaded = await db.query.scenePresets.findFirst({
      where: (p, { eq }) => eq(p.id, preset.id),
      with: { elements: { with: { instances: true } } },
    })
    const out = serializePreset(loaded as never)
    expect(out.adSpaces).toHaveLength(1)
    expect(out.adSpaces[0].sk).toBe(element.id)
    expect(out.adSpaces[0].shape).toBe('2:5')
    await app.close()
  })

  it('ad_space changes need the screens scope', () => {
    expect(scopesForElementChange('ad_space', ['shape'], [])).toContain('screens')
  })

  it('ad_events allows one row per ad, element, level, day and viewer', async () => {
    const owner = await createUser()
    const { scene } = await createScene(owner)
    const [ad] = await db.insert(ads).values({ name: 'House', kind: 'house', clickUrl: 'https://virvi.io' }).returning()
    const row = {
      adId: ad.id, elementId: crypto.randomUUID(), sceneId: scene.id, level: 'onscreen', day: '2026-10-19',
      viewerKey: 'w:0xabc', verified: true, house: true, occurredAt: new Date(),
    }
    await db.insert(adEvents).values(row).onConflictDoNothing()
    await db.insert(adEvents).values(row).onConflictDoNothing()
    // the same viewer, ad, level and day on another space is another row
    await db.insert(adEvents).values({ ...row, elementId: crypto.randomUUID() }).onConflictDoNothing()
    const rows = await db.select().from(adEvents).where(eq(adEvents.adId, ad.id))
    expect(rows).toHaveLength(2)
  })
  it('a new ad defaults to pending review', async () => {
    const [ad] = await db.insert(ads).values({ name: 'House', kind: 'house', clickUrl: 'https://virvi.io' }).returning()
    expect(ad.reviewStatus).toBe('pending')
    expect(ad.audience).toBeNull()
  })

  it('ad_space_settings and ad_space_approvals go with their element', async () => {
    const owner = await createUser()
    const { preset } = await createScene(owner)
    const el = await createElement(preset.id, { type: 'ad_space' })
    const [ad] = await db.insert(ads).values({ name: 'House', kind: 'house', clickUrl: 'https://virvi.io' }).returning()
    await db.insert(adSpaceSettings).values({ elementId: el.id, content: 'family' })
    await db.insert(adSpaceApprovals).values({ adId: ad.id, elementId: el.id, decision: 'approved' })
    await db.delete(sceneElements).where(eq(sceneElements.id, el.id))
    expect(await db.select().from(adSpaceSettings)).toHaveLength(0)
    expect(await db.select().from(adSpaceApprovals)).toHaveLength(0)
  })
})
