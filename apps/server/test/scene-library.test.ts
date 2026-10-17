import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { mediaAssets, sceneLibrary, sceneRoles, assetLibraryItems } from '../src/db/schema.js'
import { backfillSceneLibrary, listSceneLibrary, linkToScene } from '../src/library/scene-library.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, createElement, tokenFor } from './helpers/factories.js'

const media = async (ownerId: string, url = `https://cdn/x-${Math.random()}.png`) =>
  (await db.insert(mediaAssets).values({ ownerId, filename: 'x.png', contentType: 'image/png', sizeBytes: 10, storageKey: url, publicUrl: url }).returning())[0]

describe('scene library', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(async () => { await app.close() })

  it('lists only items linked to the scene', async () => {
    const owner = await createUser()
    const a = await createScene(owner, 'A'); const b = await createScene(owner, 'B')
    const m1 = await media(owner.id); const m2 = await media(owner.id)
    await linkToScene(a.scene.id, { mediaAssetId: m1.id }, owner.id)
    await linkToScene(b.scene.id, { mediaAssetId: m2.id }, owner.id)
    expect((await listSceneLibrary(a.scene.id)).map((i) => i.id)).toHaveLength(1)
    const res = await app.inject({ method: 'GET', url: `/api/scenes/${a.scene.id}/library`, headers: { authorization: `Bearer ${tokenFor(owner, { kind: 'scene', sceneId: a.scene.id, orgId: null })}` } })
    expect(res.json().items.map((i: any) => i.url)).toEqual([m1.publicUrl])
  })

  it('linking is idempotent', async () => {
    const owner = await createUser(); const a = await createScene(owner)
    const m = await media(owner.id)
    const x = await linkToScene(a.scene.id, { mediaAssetId: m.id }, owner.id)
    const y = await linkToScene(a.scene.id, { mediaAssetId: m.id }, owner.id)
    expect(x).toBe(y)
  })

  it('owner adds from own library with an account token; a scene pass cannot', async () => {
    const owner = await createUser(); const a = await createScene(owner)
    const m = await media(owner.id)
    const pass = await app.inject({ method: 'POST', url: `/api/scenes/${a.scene.id}/library`, headers: { authorization: `Bearer ${tokenFor(owner, { kind: 'scene', sceneId: a.scene.id, orgId: null })}` }, payload: { mediaAssetId: m.id } })
    expect(pass.statusCode).toBe(403)
    const acct = await app.inject({ method: 'POST', url: `/api/scenes/${a.scene.id}/library`, headers: { authorization: `Bearer ${tokenFor(owner)}` }, payload: { mediaAssetId: m.id } })
    expect(acct.statusCode).toBe(201)
  })

  it("can't add someone else's file", async () => {
    const owner = await createUser(); const other = await createUser(); const a = await createScene(owner)
    const m = await media(other.id)
    const res = await app.inject({ method: 'POST', url: `/api/scenes/${a.scene.id}/library`, headers: { authorization: `Bearer ${tokenFor(owner)}` }, payload: { mediaAssetId: m.id } })
    expect(res.statusCode).toBe(403)
  })

  it('unlinking keeps the file; editors remove only their own', async () => {
    const owner = await createUser(); const ed = await createUser({ wallet: '0x00000000000000000000000000000000000000e1' })
    const a = await createScene(owner)
    await db.insert(sceneRoles).values({ sceneId: a.scene.id, userId: ed.id, walletAddress: ed.wallet!, role: 'editor' } as any)
    const m = await media(owner.id)
    const id = await linkToScene(a.scene.id, { mediaAssetId: m.id }, owner.id)
    const edRes = await app.inject({ method: 'DELETE', url: `/api/scenes/${a.scene.id}/library/${id}`, headers: { authorization: `Bearer ${tokenFor(ed)}` } })
    expect(edRes.statusCode).toBe(403)
    const ownRes = await app.inject({ method: 'DELETE', url: `/api/scenes/${a.scene.id}/library/${id}`, headers: { authorization: `Bearer ${tokenFor(owner)}` } })
    expect(ownRes.statusCode).toBe(204)
    expect(await db.query.mediaAssets.findFirst({ where: eq(mediaAssets.id, m.id) })).toBeTruthy()
  })

  it('backfill links media and models already placed in a scene, once', async () => {
    const owner = await createUser(); const a = await createScene(owner)
    const m = await media(owner.id, 'https://cdn/placed.png')
    const [model] = await db.insert(assetLibraryItems).values({ name: 'Duck', storageKey: 'k', cdnUrl: 'https://cdn/duck.glb', uploadedBy: owner.id, isPublic: false } as any).returning()
    await createElement(a.preset.id, { type: 'image', properties: { textureSrc: 'https://cdn/placed.png' } })
    await createElement(a.preset.id, { type: 'model', properties: { modelSrc: 'https://cdn/duck.glb' } })
    expect(await backfillSceneLibrary()).toBe(2)
    expect(await backfillSceneLibrary()).toBe(0)
    const rows = await db.select().from(sceneLibrary).where(eq(sceneLibrary.sceneId, a.scene.id))
    expect(rows.map((r) => r.mediaAssetId ?? r.assetItemId).sort()).toEqual([m.id, model.id].sort())
  })
})
