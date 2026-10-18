import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { db } from '../src/db/connection.js'
import { mediaAssets, sceneCollaborators } from '../src/db/schema.js'
import { linkToScene } from '../src/library/scene-library.js'
import { publishLibraryChanged } from '../src/realtime/bus.js'
import { resetDb } from './helpers/db.js'
import { createUser, createScene, tokenFor } from './helpers/factories.js'
import { startGameServer, joinScene } from './helpers/game-server.js'

describe('scene library live changes', () => {
  let gs: Awaited<ReturnType<typeof startGameServer>>
  beforeEach(async () => {
    await resetDb()
    gs = await startGameServer()
  })
  afterEach(() => gs.stop())

  async function setup() {
    const ownerU = await createUser()
    const { scene } = await createScene(ownerU)
    const editorU = await createUser()
    const viewerU = await createUser()
    await db.insert(sceneCollaborators).values([
      { sceneId: scene.id, userId: editorU.id, role: 'editor' },
      { sceneId: scene.id, userId: viewerU.id, role: 'viewer' },
    ])
    const owner = await joinScene(gs.url, scene.id, tokenFor(ownerU))
    const editor = await joinScene(gs.url, scene.id, tokenFor(editorU))
    const viewer = await joinScene(gs.url, scene.id, tokenFor(viewerU))
    for (const c of [owner, editor, viewer]) await c.waitFor('scene_preset_update')
    const media = async () => {
      const [m] = await db.insert(mediaAssets).values({
        ownerId: ownerU.id, filename: 'a.png', contentType: 'image/png', sizeBytes: 10, storageKey: 'k', publicUrl: 'https://x/a.png',
      }).returning()
      return m
    }
    return { ownerU, scene, owner, editor, viewer, media }
  }

  it('relays a library upsert to every editor and not to viewers', async () => {
    const s = await setup()
    const m = await s.media()
    const [{ id: linkId }] = await db.execute<{ id: string }>(
      // insert directly so linkToScene's own publish doesn't fire first
      (await import('drizzle-orm')).sql`INSERT INTO scene_library (scene_id, media_asset_id) VALUES (${s.scene.id}, ${m.id}) RETURNING id`,
    ) as unknown as { id: string }[]
    await publishLibraryChanged(s.scene.id, linkId)
    expect(await s.editor.waitFor('scene_library_changed')).toMatchObject({ action: 'upsert', item: { id: linkId, status: 'ready' } })
    expect(await s.owner.waitFor('scene_library_changed')).toMatchObject({ action: 'upsert', item: { id: linkId } })
    await s.viewer.expectNone('scene_library_changed', 300)
  })

  it('relays a removal', async () => {
    const s = await setup()
    await publishLibraryChanged(s.scene.id, 'gone-id', true)
    expect(await s.editor.waitFor('scene_library_changed')).toEqual({ action: 'remove', id: 'gone-id' })
  })

  it('linkToScene publishes', async () => {
    const s = await setup()
    const m = await s.media()
    const linkId = await linkToScene(s.scene.id, { mediaAssetId: m.id }, s.ownerU.id)
    expect(await s.editor.waitFor('scene_library_changed')).toMatchObject({ action: 'upsert', item: { id: linkId } })
  })
})
