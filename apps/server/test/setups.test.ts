import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { analyticsScenes, locationSetups, sceneRoles, scenes, scenePresets } from '../src/db/schema.js'
import { setDclDirectory } from '../src/analytics/dcl-directory.js'
import { controls } from '../src/analytics/claims.js'
import { getActiveSetup, releaseIfRedeployed, setUpLocation, SetupError } from '../src/setup/setups.js'
import { resetDb } from './helpers/db.js'
import { createAnalyticsScene } from './helpers/analytics.js'
import { FakeDclDirectory } from './helpers/fake-dcl.js'
import { randomWallet } from './helpers/factories.js'

describe('setup domain', () => {
  let dir: FakeDclDirectory
  beforeEach(async () => {
    await resetDb()
    dir = new FakeDclDirectory()
    setDclDirectory(dir)
  })
  afterEach(() => setDclDirectory(null))

  it('World deployers on the allow-list control the World', async () => {
    const w = randomWallet()
    const s = await createAnalyticsScene({ locationKey: 'world:x.dcl.eth', kind: 'world', worldName: 'x.dcl.eth', parcels: [] })
    dir.worldOwners.set('x.dcl.eth', randomWallet())
    dir.worldDeployers.set('x.dcl.eth', [w])
    expect(await controls(s, w, dir)).toBe(true)
    expect(await controls(s, randomWallet(), dir)).toBe(false)
  })

  it('setUpLocation creates the user, scene (with default preset), setup and link in one go; second call is 409', async () => {
    const w = randomWallet()
    const s = await createAnalyticsScene({ locationKey: 'gc:1,1', parcels: ['1,1'], title: 'My Venue', activeEntityId: 'bafyA', walletVisibility: true })
    const r = await setUpLocation(s, w)
    // A new host starts with wallet visibility off, whatever an earlier tenure chose.
    expect((await db.query.analyticsScenes.findFirst({ where: eq(analyticsScenes.id, s.id) }))!.walletVisibility).toBe(false)
    const scene = await db.query.scenes.findFirst({ where: eq(scenes.id, r.vlmSceneId) })
    expect(scene).toMatchObject({ ownerId: r.userId, name: 'My Venue' })
    expect(scene!.activePresetId).toBeTruthy()
    expect(await db.query.scenePresets.findFirst({ where: eq(scenePresets.sceneId, r.vlmSceneId) })).toBeTruthy()
    expect(r.setup).toMatchObject({ analyticsSceneId: s.id, vlmSceneId: r.vlmSceneId, hostUserId: r.userId, deploymentEntityId: 'bafyA', endedAt: null })
    expect((await db.query.analyticsScenes.findFirst({ where: eq(analyticsScenes.id, s.id) }))!.vlmSceneId).toBe(r.vlmSceneId)
    await expect(setUpLocation(s, randomWallet())).rejects.toMatchObject({ status: 409, code: 'already_set_up' })
  })

  it('concurrent setUpLocation calls produce exactly one active setup', async () => {
    const s = await createAnalyticsScene({ locationKey: 'gc:2,2', parcels: ['2,2'] })
    const results = await Promise.allSettled([setUpLocation(s, randomWallet()), setUpLocation(s, randomWallet())])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toBeInstanceOf(SetupError)
    expect(await db.select().from(locationSetups)).toHaveLength(1)
  })

  it('a redeploy by the host or a co-host keeps the setup (and records the new entity)', async () => {
    const host = randomWallet()
    const co = randomWallet()
    const s = await createAnalyticsScene({ locationKey: 'gc:3,3', parcels: ['3,3'], baseParcel: '3,3', activeEntityId: 'bafyA' })
    const { setup, vlmSceneId } = await setUpLocation(s, host)
    await db.insert(sceneRoles).values({ sceneId: vlmSceneId, walletAddress: co, role: 'cohost' })
    dir.addScene({ entityId: 'bafyB', base: '3,3', parcels: ['3,3'] }, co)
    const kept = await releaseIfRedeployed(setup, s, dir)
    expect(kept).toMatchObject({ id: setup.id, deploymentEntityId: 'bafyB', endedAt: null })
  })

  it('a redeploy by anyone else ends the setup and the location can be set up again', async () => {
    const s = await createAnalyticsScene({ locationKey: 'gc:4,4', parcels: ['4,4'], baseParcel: '4,4', activeEntityId: 'bafyA' })
    const { setup } = await setUpLocation(s, randomWallet())
    await db.update(analyticsScenes).set({ walletVisibility: true }).where(eq(analyticsScenes.id, s.id))
    dir.addScene({ entityId: 'bafyC', base: '4,4', parcels: ['4,4'] }, randomWallet())
    expect(await releaseIfRedeployed(setup, s, dir)).toBeNull()
    expect((await db.query.analyticsScenes.findFirst({ where: eq(analyticsScenes.id, s.id) }))!.walletVisibility).toBe(false)
    const ended = await db.query.locationSetups.findFirst({ where: eq(locationSetups.id, setup.id) })
    expect(ended).toMatchObject({ endReason: 'redeployed' })
    expect(ended!.endedAt).toBeInstanceOf(Date)
    expect(await getActiveSetup(s.id)).toBeNull()
    await expect(setUpLocation(s, randomWallet())).resolves.toBeTruthy()
  })

  it('same deployment entity: nothing changes and no deployer lookup is needed', async () => {
    const s = await createAnalyticsScene({ locationKey: 'gc:5,5', parcels: ['5,5'], baseParcel: '5,5', activeEntityId: 'bafyA' })
    const { setup } = await setUpLocation(s, randomWallet())
    dir.addScene({ entityId: 'bafyA', base: '5,5', parcels: ['5,5'] }, randomWallet())
    expect(await releaseIfRedeployed(setup, s, dir)).toMatchObject({ id: setup.id, endedAt: null })
  })

  it('World: a new version keeps the setup only if host/co-host is the owner or an allowed deployer', async () => {
    const host = randomWallet()
    const s = await createAnalyticsScene({ locationKey: 'world:y.dcl.eth', kind: 'world', worldName: 'y.dcl.eth', parcels: [], activeEntityId: 'bafyA' })
    const { setup } = await setUpLocation(s, host)
    dir.worlds.set('y.dcl.eth', { sceneUrns: ['urn:decentraland:entity:bafyW2?=&baseUrl=x'] })
    dir.worldOwners.set('y.dcl.eth', host)
    expect(await releaseIfRedeployed(setup, s, dir)).toMatchObject({ deploymentEntityId: 'bafyW2', endedAt: null })
    dir.worlds.set('y.dcl.eth', { sceneUrns: ['urn:decentraland:entity:bafyW3'] })
    dir.worldOwners.set('y.dcl.eth', randomWallet())
    expect(await releaseIfRedeployed((await getActiveSetup(s.id))!, s, dir)).toBeNull()
  })

  it('unknown deployer keeps the setup unchanged', async () => {
    const s = await createAnalyticsScene({ locationKey: 'gc:6,6', parcels: ['6,6'], baseParcel: '6,6', activeEntityId: 'bafyA' })
    const { setup } = await setUpLocation(s, randomWallet())
    dir.addScene({ entityId: 'bafyD', base: '6,6', parcels: ['6,6'] })
    expect(await releaseIfRedeployed(setup, s, dir)).toMatchObject({ id: setup.id, deploymentEntityId: 'bafyA', endedAt: null })
    expect(await getActiveSetup(s.id)).toMatchObject({ id: setup.id, endedAt: null })
  })

  it('a stale release call cannot end a newer setup', async () => {
    const s = await createAnalyticsScene({ locationKey: 'gc:7,7', parcels: ['7,7'], baseParcel: '7,7', activeEntityId: 'bafyA' })
    const { setup: a } = await setUpLocation(s, randomWallet())
    dir.addScene({ entityId: 'bafyE', base: '7,7', parcels: ['7,7'] }, randomWallet())
    expect(await releaseIfRedeployed(a, s, dir)).toBeNull()
    const b = await setUpLocation(s, randomWallet())
    expect(await releaseIfRedeployed(a, s, dir)).toBeNull()
    expect(await getActiveSetup(s.id)).toMatchObject({ id: b.setup.id, endedAt: null })
    expect((await db.query.analyticsScenes.findFirst({ where: eq(analyticsScenes.id, s.id) }))!.vlmSceneId).toBe(b.vlmSceneId)
  })
})
