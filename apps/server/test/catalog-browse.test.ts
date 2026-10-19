import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { assetLibraryItems, catalogPacks, sceneRoles } from '../src/db/schema.js'
import { listSceneLibrary, linkToScene } from '../src/library/scene-library.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, tokenFor, randomWallet } from './helpers/factories.js'

const pack = (id: string, enabled = true) => ({ id, name: `Pack ${id}`, source: 'last-slice', license: 'unstated', attribution: `Models by ${id}`, sourceUrl: 'https://github.com/last-slice/iwb-3d-wip', enabled })
let n = 0
const model = (packId: string | null, values: Partial<typeof assetLibraryItems.$inferInsert> = {}) => {
  n++
  return db.insert(assetLibraryItems).values({
    name: `Model ${n}`, storageKey: `catalog/${packId}/${n}.glb`, cdnUrl: `https://cdn/${n}.glb`, packId, sourceRef: `m${n}`,
    isPublic: true, category: 'Furniture', style: 'Cozy', venueTags: ['cafe'], ...values,
  }).returning().then((r) => r[0])
}

describe('catalog browse and linking', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => {
    await resetDb()
    app = await testApp()
    await db.insert(catalogPacks).values([pack('on'), pack('off', false)])
  })
  afterEach(async () => { await app.close() })

  const list = async (qs = '') => (await app.inject({ method: 'GET', url: `/api/assets${qs}` })).json()

  it('lists only models from enabled packs, and total matches', async () => {
    const a = await model('on'); await model('off'); const own = await model(null)
    const body = await list()
    expect(body.assets.map((x: any) => x.id).sort()).toEqual([a.id, own.id].sort())
    expect(body.total).toBe(2)
  })

  it('filters by style, venue, pack and category', async () => {
    const cafe = await model('on', { venueTags: ['cafe', 'bar'] })
    const club = await model('on', { venueTags: ['club'], style: 'Cyberpunk', category: 'Lighting' })
    expect((await list('?venue=cafe')).assets.map((x: any) => x.id)).toEqual([cafe.id])
    expect((await list('?style=Cyberpunk')).assets.map((x: any) => x.id)).toEqual([club.id])
    expect((await list('?category=Lighting')).assets.map((x: any) => x.id)).toEqual([club.id])
    expect((await list('?pack=on')).total).toBe(2)
    expect((await list('?pack=off')).total).toBe(0)
  })

  it('returns pack name, license and attribution with each model', async () => {
    await model('on'); await model(null)
    const byPack = Object.fromEntries((await list()).assets.map((x: any) => [x.packId ?? 'none', x.pack]))
    expect(byPack.on).toEqual({ id: 'on', name: 'Pack on', license: 'unstated', attribution: 'Models by on' })
    expect(byPack.none).toBeNull()
  })

  it('categories leave out disabled packs', async () => {
    await model('on', { category: 'Furniture' }); await model('off', { category: 'Vehicles' })
    const res = await app.inject({ method: 'GET', url: '/api/assets/categories' })
    expect(res.json().categories).toEqual(['Furniture'])
  })

  it('GET /api/assets/:id still returns a model from a disabled pack', async () => {
    const m = await model('off')
    const res = await app.inject({ method: 'GET', url: `/api/assets/${m.id}` })
    expect(res.statusCode).toBe(200)
    expect(res.json().asset.id).toBe(m.id)
  })

  async function editorSetup() {
    const owner = await createUser()
    const { scene } = await createScene(owner)
    const ed = await createUser({ wallet: randomWallet() })
    await db.insert(sceneRoles).values({ sceneId: scene.id, userId: ed.id, walletAddress: ed.wallet!, role: 'editor' } as any)
    const add = (assetItemId: string, who = ed) => app.inject({ method: 'POST', url: `/api/scenes/${scene.id}/library`, headers: { authorization: `Bearer ${tokenFor(who)}` }, payload: { assetItemId } })
    return { owner, scene, ed, add }
  }

  it('an editor can add an enabled catalog model to the scene library', async () => {
    const { scene, add } = await editorSetup()
    const m = await model('on')
    const res = await add(m.id)
    expect(res.statusCode).toBe(201)
    expect((await listSceneLibrary(scene.id)).map((i) => i.url)).toEqual([m.cdnUrl])
  })

  it('adding a disabled pack model gives 409 pack_disabled', async () => {
    const { add } = await editorSetup()
    const m = await model('off')
    const res = await add(m.id)
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('pack_disabled')
  })

  it('a disabled pack model already linked still lists in the scene library', async () => {
    const { scene, owner } = await editorSetup()
    const m = await model('on')
    await linkToScene(scene.id, { assetItemId: m.id }, owner.id)
    await db.update(catalogPacks).set({ enabled: false }).where(eq(catalogPacks.id, 'on'))
    expect((await listSceneLibrary(scene.id)).map((i) => i.url)).toEqual([m.cdnUrl])
  })

  it('linkToScene refuses a disabled pack model', async () => {
    const { scene, owner } = await editorSetup()
    const m = await model('off')
    await expect(linkToScene(scene.id, { assetItemId: m.id }, owner.id)).rejects.toMatchObject({ code: 'pack_disabled' })
  })

  it("someone else's private upload is still refused", async () => {
    const { add } = await editorSetup()
    const stranger = await createUser()
    const m = await model(null, { isPublic: false, uploadedBy: stranger.id, sourceRef: null })
    expect((await add(m.id)).statusCode).toBe(403)
  })
})
