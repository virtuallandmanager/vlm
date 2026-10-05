import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { analyticsScenes } from '../src/db/schema.js'
import { setDclDirectory, HttpDclDirectory, DirectoryUnavailableError } from '../src/analytics/dcl-directory.js'
import { resolveAnalyticsScene, clearRegistryCache, setValidationBudget } from '../src/analytics/registry.js'
import { TokenBucketLimiter } from '../src/analytics/limiter.js'
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
  afterEach(() => {
    setDclDirectory(null)
    setValidationBudget(null)
  })

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

  it('a bogus parcel claim gets 422 without poisoning the cache for correct batches', async () => {
    dir.addScene({ entityId: 'bafyA', base: '10,10', parcels: ['10,10', '10,11'] })
    const bad = await resolveAnalyticsScene(gc({ entityId: 'bafyA', parcels: ['10,10', '99,99'] }), null)
    expect(bad).toMatchObject({ ok: false, status: 422 })
    expect((await resolveAnalyticsScene(gc({ entityId: 'bafyA' }), null)).ok).toBe(true)
  })

  it('a cache hit still rejects parcels outside the scene', async () => {
    dir.addScene({ entityId: 'bafyA', base: '10,10', parcels: ['10,10', '10,11'] })
    expect((await resolveAnalyticsScene(gc(), null)).ok).toBe(true)
    const calls = dir.calls
    expect(await resolveAnalyticsScene(gc({ parcels: ['10,10', '99,99'] }), null)).toMatchObject({ ok: false, status: 422 })
    expect(dir.calls).toBe(calls)
  })

  it('worlds: entity id must equal the parsed URN id, and the parsed id is stored', async () => {
    dir.worlds.set('foo.dcl.eth', { sceneUrns: ['urn:decentraland:entity:bafyW?=&baseUrl=x'] })
    const w = { realm: 'foo.dcl.eth', isWorld: true, isPreview: false, worldName: 'foo.dcl.eth' }
    expect(await resolveAnalyticsScene({ ...w, entityId: 'urn' }, null)).toMatchObject({ ok: false, status: 422 })
    const r = await resolveAnalyticsScene({ ...w, entityId: 'bafyW' }, null)
    expect(r.ok && r.scene.activeEntityId).toBe('bafyW')
  })

  it('global validation budget: past 20 directory validations per second, unknown scenes get 503 and known scenes are accepted stale', async () => {
    setValidationBudget(new TokenBucketLimiter(() => 0)) // frozen clock: no refill
    dir.addScene({ entityId: 'bafyA', base: '10,10', parcels: ['10,10', '10,11'] })
    expect((await resolveAnalyticsScene(gc(), null)).ok).toBe(true) // 1 validation
    for (let i = 0; i < 19; i++) {
      const p = `${60 + i},60`
      dir.addScene({ entityId: `bafy${i}`, base: p, parcels: [p] })
      expect((await resolveAnalyticsScene(gc({ baseParcel: p, parcels: [p] }), null)).ok).toBe(true)
    }
    dir.addScene({ entityId: 'bafyZ', base: '99,99', parcels: ['99,99'] })
    const calls = dir.calls
    expect(await resolveAnalyticsScene(gc({ baseParcel: '99,99', parcels: ['99,99'] }), null)).toMatchObject({ ok: false, status: 503, error: 'upstream_unavailable' })
    // Known scene whose cache expired: accepted stale without a directory call.
    expect((await resolveAnalyticsScene(gc(), null, new Date(Date.now() + 11 * 60_000))).ok).toBe(true)
    expect(dir.calls).toBe(calls)
  })

  it('preview: reports whether a row was created, and refuses a new row when allowNewPreview says no', async () => {
    const ref = { realm: 'localhost', isWorld: false, isPreview: true, baseParcel: '0,0' }
    const first = await resolveAnalyticsScene(ref, '0xabc')
    expect(first).toMatchObject({ ok: true, created: true })
    const again = await resolveAnalyticsScene(ref, '0xabc', new Date(), { allowNewPreview: () => false })
    expect(again).toMatchObject({ ok: true, created: false })
    const blocked = await resolveAnalyticsScene({ ...ref, baseParcel: '1,1' }, '0xabc', new Date(), { allowNewPreview: () => false })
    expect(blocked).toMatchObject({ ok: false, status: 429, error: 'rate_limited' })
    expect(await db.select().from(analyticsScenes).where(eq(analyticsScenes.locationKey, 'preview:0xabc:1,1'))).toHaveLength(0)
  })

  it('upstream down: a second batch within 60s makes no further directory calls', async () => {
    dir.addScene({ entityId: 'bafyA', base: '10,10', parcels: ['10,10', '10,11'] })
    await resolveAnalyticsScene(gc(), null)
    dir.down = true
    const later = Date.now() + 11 * 60_000
    expect((await resolveAnalyticsScene(gc(), null, new Date(later))).ok).toBe(true)
    const calls = dir.calls
    expect((await resolveAnalyticsScene(gc(), null, new Date(later + 30_000))).ok).toBe(true)
    expect(dir.calls).toBe(calls)
  })
})

describe('HttpDclDirectory error semantics', () => {
  afterEach(() => vi.restoreAllMocks())
  const stub = (res: Response) => vi.spyOn(globalThis, 'fetch').mockResolvedValue(res)
  const http = () => new HttpDclDirectory('http://catalyst.test', 'http://worlds.test')

  it('404 means not found', async () => {
    stub(new Response('', { status: 404 }))
    expect(await http().getActiveSceneAt('1,1')).toBeNull()
  })
  it('429 is upstream unavailable', async () => {
    stub(new Response('', { status: 429 }))
    await expect(http().getActiveSceneAt('1,1')).rejects.toBeInstanceOf(DirectoryUnavailableError)
  })
  it('a 200 with a non-JSON body is upstream unavailable', async () => {
    stub(new Response('<html>oops</html>', { status: 200 }))
    await expect(http().getActiveSceneAt('1,1')).rejects.toBeInstanceOf(DirectoryUnavailableError)
  })
})
