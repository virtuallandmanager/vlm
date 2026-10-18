import { describe, it, expect, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { mediaAssets } from '../src/db/schema.js'
import { getSceneLibraryItem, linkToScene, listSceneLibrary } from '../src/library/scene-library.js'
import { resetDb } from './helpers/db.js'
import { createUser, createScene } from './helpers/factories.js'

describe('scene library status', () => {
  beforeEach(async () => { await resetDb() })

  async function setup() {
    const owner = await createUser()
    const { scene } = await createScene(owner)
    const add = async (values: Partial<typeof mediaAssets.$inferInsert>) => {
      const [m] = await db.insert(mediaAssets).values({
        ownerId: owner.id, filename: 'a.png', contentType: 'image/png', sizeBytes: 10, storageKey: 'k', publicUrl: 'https://x/a.png', ...values,
      }).returning()
      const linkId = await linkToScene(scene.id, { mediaAssetId: m.id }, owner.id)
      return { m, linkId }
    }
    return { owner, scene, add }
  }

  it('lists a media item with its status and error', async () => {
    const { scene, add } = await setup()
    await add({ status: 'processing', storageKey: null, publicUrl: null })
    const [item] = await listSceneLibrary(scene.id)
    expect(item).toMatchObject({ status: 'processing', error: null, url: '', sizeBytes: 10 })
  })

  it('marks uploads stuck in uploading for 15 minutes as failed', async () => {
    const { scene, add } = await setup()
    const old = await add({ status: 'uploading', storageKey: null, publicUrl: null, createdAt: new Date(Date.now() - 16 * 60_000) })
    const fresh = await add({ filename: 'b.png', status: 'uploading', storageKey: null, publicUrl: null, createdAt: new Date(Date.now() - 60_000) })
    const items = await listSceneLibrary(scene.id)
    expect(items.find((i) => i.id === old.linkId)).toMatchObject({ status: 'failed', error: "Upload didn't finish" })
    expect(items.find((i) => i.id === fresh.linkId)).toMatchObject({ status: 'uploading' })
  })

  it('also fails uploads stuck in processing (a crash mid-store)', async () => {
    const { scene, add } = await setup()
    const stuck = await add({ status: 'processing', storageKey: null, publicUrl: null, createdAt: new Date(Date.now() - 16 * 60_000) })
    const items = await listSceneLibrary(scene.id)
    expect(items.find((i) => i.id === stuck.linkId)).toMatchObject({ status: 'failed', error: "Upload didn't finish" })
  })

  it('defaults existing-style inserts to ready', async () => {
    const { add } = await setup()
    const { m } = await add({})
    const row = await db.query.mediaAssets.findFirst({ where: eq(mediaAssets.id, m.id) })
    expect(row!.status).toBe('ready')
  })

  it('getSceneLibraryItem returns one item or null', async () => {
    const { scene, add } = await setup()
    const { linkId } = await add({})
    const [listed] = await listSceneLibrary(scene.id)
    expect(await getSceneLibraryItem(scene.id, linkId)).toEqual(listed)
    expect(await getSceneLibraryItem(scene.id, crypto.randomUUID())).toBeNull()
  })
})
