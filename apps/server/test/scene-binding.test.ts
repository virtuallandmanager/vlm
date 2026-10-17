import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb } from './helpers/db.js'
import { createUser, createScene } from './helpers/factories.js'
import { createAnalyticsScene } from './helpers/analytics.js'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { locationSetups } from '../src/db/schema.js'
import { createSetup } from './helpers/setups.js'
import { FakeDclDirectory } from './helpers/fake-dcl.js'
import { setDclDirectory } from '../src/analytics/dcl-directory.js'
import { bindSceneRequest, locationKeyForContext } from '../src/auth/scene-binding.js'

const ctx = (o: Partial<{ sceneId: string; parcel: string; serverName: string; hostname: string }> = {}) => ({
  sceneId: o.sceneId ?? 'bafyA',
  parcel: o.parcel ?? '10,20',
  realm: { hostname: o.hostname ?? 'peer.decentraland.org', serverName: o.serverName ?? 'main' },
  isGuest: false,
})

describe('scene binding', () => {
  beforeEach(async () => { await resetDb(); setDclDirectory(new FakeDclDirectory()) })

  it('location keys: Genesis City realms are never Worlds; World names are lowercased', () => {
    for (const serverName of ['main', 'realm-1', 'hela']) expect(locationKeyForContext(ctx({ serverName }), '0xa', false)).toBe('gc:10,20')
    expect(locationKeyForContext(ctx({ serverName: 'MyWorld.dcl.eth' }), '0xa', false)).toBe('world:myworld.dcl.eth')
    expect(locationKeyForContext(ctx(), '0xA', true)).toBe('preview:0xa:10,20')
  })

  it('binds a Genesis City parcel to the active setup of its location', async () => {
    const owner = await createUser({ wallet: '0x00000000000000000000000000000000000000a1' })
    const { scene } = await createScene(owner)
    const loc = await createAnalyticsScene({ locationKey: 'gc:10,20', baseParcel: '10,20', parcels: ['10,20', '10,21'], activeEntityId: 'bafyA' } as any)
    await createSetup(loc.id, scene.id)
    expect(await bindSceneRequest(ctx(), owner.wallet!)).toEqual({ locationId: loc.id, sceneId: scene.id })
  })

  it('finds the location by any of its parcels when the base key misses', async () => {
    const owner = await createUser()
    const { scene } = await createScene(owner)
    const loc = await createAnalyticsScene({ locationKey: 'gc:10,19', baseParcel: '10,19', parcels: ['10,19', '10,20'] } as any)
    await createSetup(loc.id, scene.id)
    expect((await bindSceneRequest(ctx(), '0xa')).sceneId).toBe(scene.id)
  })

  it('binds a World by name', async () => {
    const owner = await createUser()
    const { scene } = await createScene(owner)
    const loc = await createAnalyticsScene({ kind: 'world', locationKey: 'world:myworld.dcl.eth', worldName: 'myworld.dcl.eth', baseParcel: '0,0', parcels: ['0,0'] } as any)
    await createSetup(loc.id, scene.id)
    expect((await bindSceneRequest(ctx({ serverName: 'myworld.dcl.eth', parcel: '0,0' }), '0xa')).sceneId).toBe(scene.id)
  })

  it('no location, or a location with no active setup → visitor binding', async () => {
    expect(await bindSceneRequest(ctx(), '0xa')).toEqual({ locationId: null, sceneId: null })
    const loc = await createAnalyticsScene({ locationKey: 'gc:10,20', baseParcel: '10,20', parcels: ['10,20'] } as any)
    expect(await bindSceneRequest(ctx(), '0xa')).toEqual({ locationId: loc.id, sceneId: null })
  })

  it('directory down while checking a changed deployment → visitor binding', async () => {
    const owner = await createUser()
    const { scene } = await createScene(owner)
    const loc = await createAnalyticsScene({ locationKey: 'gc:10,20', baseParcel: '10,20', parcels: ['10,20'], activeEntityId: 'bafyOld' } as any)
    const setup = await createSetup(loc.id, scene.id)
    await db.update(locationSetups).set({ deploymentEntityId: 'bafyOld' }).where(eq(locationSetups.id, setup.id))
    const dir = new FakeDclDirectory(); dir.down = true; setDclDirectory(dir)
    expect(await bindSceneRequest(ctx({ sceneId: 'bafyNew' }), '0xa')).toEqual({ locationId: loc.id, sceneId: null })
  })
})
