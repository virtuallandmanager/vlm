import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { analyticsScenes } from '../src/db/schema.js'
import { setDclDirectory } from '../src/analytics/dcl-directory.js'
import { resolveAnalyticsScene, clearRegistryCache } from '../src/analytics/registry.js'
import { resetDb } from './helpers/db.js'
import { FakeDclDirectory } from './helpers/fake-dcl.js'

const gc = (extra = {}) => ({ realm: 'main', isWorld: false, isPreview: false, baseParcel: '10,10', parcels: ['10,10', '10,11'], ...extra })

describe('resolveAnalyticsScene', () => {
  let dir: FakeDclDirectory
  beforeEach(async () => {
    await resetDb()
    clearRegistryCache()
    dir = new FakeDclDirectory()
    setDclDirectory(dir)
  })
  afterEach(() => setDclDirectory(null))

  it('registers a deployed Genesis City scene on first sight with a fresh salt', async () => {
    dir.addScene({ entityId: 'bafyA', base: '10,10', parcels: ['10,10', '10,11'], title: 'Caldera' })
    const r = await resolveAnalyticsScene(gc({ entityId: 'bafyA' }), null)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.scene).toMatchObject({ locationKey: 'gc:10,10', kind: 'parcels', activeEntityId: 'bafyA', title: 'Caldera' })
    expect(r.scene.salt).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rejects a location with no scene, a wrong base, or parcels outside the scene', async () => {
    expect(await resolveAnalyticsScene(gc(), null)).toMatchObject({ ok: false, status: 422 })
    clearRegistryCache()
    dir.addScene({ entityId: 'bafyA', base: '10,11', parcels: ['10,10', '10,11'] })
    expect(await resolveAnalyticsScene(gc(), null)).toMatchObject({ ok: false, status: 422 })
    clearRegistryCache()
    dir.addScene({ entityId: 'bafyA', base: '10,10', parcels: ['10,10'] })
    expect(await resolveAnalyticsScene(gc(), null)).toMatchObject({ ok: false, status: 422 })
  })

  it('caches results for 10 minutes', async () => {
    dir.addScene({ entityId: 'bafyA', base: '10,10', parcels: ['10,10', '10,11'] })
    await resolveAnalyticsScene(gc(), null)
    const after = dir.calls
    await resolveAnalyticsScene(gc(), null)
    expect(dir.calls).toBe(after)
    await resolveAnalyticsScene(gc(), null, new Date(Date.now() + 11 * 60_000))
    expect(dir.calls).toBeGreaterThan(after)
  })

  it('redeploy: the old entity id is rejected, the new one accepted, same location row', async () => {
    dir.addScene({ entityId: 'bafyA', base: '10,10', parcels: ['10,10', '10,11'] })
    const first = await resolveAnalyticsScene(gc({ entityId: 'bafyA' }), null)
    dir.addScene({ entityId: 'bafyB', base: '10,10', parcels: ['10,10', '10,11'] })
    const stale = await resolveAnalyticsScene(gc({ entityId: 'bafyA' }), null, new Date(Date.now() + 11 * 60_000))
    expect(stale).toMatchObject({ ok: false, status: 422 })
    const fresh = await resolveAnalyticsScene(gc({ entityId: 'bafyB' }), null, new Date(Date.now() + 11 * 60_000))
    expect(fresh.ok && first.ok && fresh.scene.id === first.scene.id).toBe(true)
    expect(fresh.ok && fresh.scene.activeEntityId).toBe('bafyB')
  })

  it('upstream down: known scene accepted stale, unknown scene 503', async () => {
    dir.addScene({ entityId: 'bafyA', base: '10,10', parcels: ['10,10', '10,11'] })
    await resolveAnalyticsScene(gc(), null)
    dir.down = true
    expect((await resolveAnalyticsScene(gc(), null, new Date(Date.now() + 11 * 60_000))).ok).toBe(true)
    expect(await resolveAnalyticsScene(gc({ baseParcel: '50,50', parcels: ['50,50'] }), null)).toMatchObject({ ok: false, status: 503, error: 'upstream_unavailable' })
  })

  it('worlds: validated by the worlds server, keyed by lowercased name', async () => {
    dir.worlds.set('foo.dcl.eth', { sceneUrns: ['urn:decentraland:entity:bafyW?=&baseUrl=x'], title: 'Foo' })
    const r = await resolveAnalyticsScene({ realm: 'Foo.dcl.eth', isWorld: true, isPreview: false, worldName: 'Foo.dcl.eth', entityId: 'bafyW' }, null)
    expect(r.ok && r.scene.locationKey).toBe('world:foo.dcl.eth')
    expect(await resolveAnalyticsScene({ realm: 'nope.dcl.eth', isWorld: true, isPreview: false, worldName: 'nope.dcl.eth' }, null)).toMatchObject({ ok: false, status: 422 })
  })

  it('preview scenes skip validation and are keyed by signer', async () => {
    dir.down = true
    const r = await resolveAnalyticsScene({ realm: 'localhost', isWorld: false, isPreview: true, baseParcel: '0,0' }, '0xabc')
    expect(r.ok && r.scene).toMatchObject({ locationKey: 'preview:0xabc:0,0', kind: 'preview', isPreview: true })
  })

  it('concurrent first sightings create one row', async () => {
    dir.addScene({ entityId: 'bafyA', base: '10,10', parcels: ['10,10', '10,11'] })
    await Promise.all([resolveAnalyticsScene(gc(), null), resolveAnalyticsScene(gc(), null)])
    expect(await db.select().from(analyticsScenes).where(eq(analyticsScenes.locationKey, 'gc:10,10'))).toHaveLength(1)
  })
})
