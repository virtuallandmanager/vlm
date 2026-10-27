import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import postgres from 'postgres'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { assetLibraryItems, hyperfyWorlds, mediaAssets, sceneElements, streamingServers } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { createUser, createScene, createElement } from './helpers/factories.js'
// @ts-expect-error plain .mjs script, no types
import { rewriteHosts, rewriteStoredUrls } from '../scripts/rewrite-legacy-urls.mjs'

// The old host, which this test rewrites.
const OLD = ['vlm', 'gg'].join('.') // virvi-rename: keep

describe('rewriteHosts', () => {
  it('maps each old host to its virvi.io equivalent', () => {
    const cases: Array<[string, string]> = [
      [`https://cdn.${OLD}/m.glb`, 'https://cdn.virvi.io/m.glb'],
      [`https://live.${OLD}/streams/x/playlist.m3u8`, 'https://live.virvi.io/streams/x/playlist.m3u8'],
      [`rtmp://ingest.${OLD}/live`, 'rtmp://ingest.virvi.io/live'],
      [`https://worlds-cdn.${OLD}/a`, 'https://worlds-cdn.virvi.io/a'],
      [`moon.worlds.${OLD}`, 'moon.worlds.virvi.io'],
      [`https://api.${OLD}:443/x`, 'https://api.virvi.io:443/x'],
      [`https://staging-api.${OLD}`, 'https://api.staging.virvi.io'],
      [`https://${OLD}/s/ABC?x=1#y`, 'https://virvi.io/s/ABC?x=1#y'],
      [`support@${OLD}`, 'support@virvi.io'],
      [`{"src":"https://cdn.${OLD}/m.glb"}`, '{"src":"https://cdn.virvi.io/m.glb"}'],
    ]
    for (const [from, to] of cases) expect(rewriteHosts(from), from).toBe(to)
  })

  it('leaves look-alikes alone', () => {
    for (const s of [`https://not${OLD}.example.com/x`, `https://${OLD}x/y`, `https://${OLD}.example.com/x`, 'https://virvi.io/x']) {
      expect(rewriteHosts(s), s).toBe(s)
    }
  })

  it('is idempotent', () => {
    const s = `https://cdn.${OLD}/a https://${OLD}/b`
    expect(rewriteHosts(rewriteHosts(s))).toBe(rewriteHosts(s))
  })
})

describe('rewriteStoredUrls', () => {
  const client = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} })
  afterAll(() => client.end())
  beforeEach(async () => {
    await resetDb()
    await client`DROP SCHEMA IF EXISTS retired CASCADE`
  })

  async function seed() {
    const u = await createUser()
    const { scene, preset } = await createScene(u)
    const [asset] = await db.insert(assetLibraryItems).values({ name: 'a', storageKey: 'k', cdnUrl: `https://cdn.${OLD}/a.glb`, thumbnailUrl: `https://cdn.${OLD}/a.png` }).returning()
    const [media] = await db.insert(mediaAssets).values({ ownerId: u.id, filename: 'm.png', contentType: 'image/png', sizeBytes: 1, publicUrl: `https://cdn.${OLD}/m.png` }).returning()
    const [stream] = await db.insert(streamingServers).values({ ownerId: u.id, name: 's', rtmpUrl: `rtmp://ingest.${OLD}/live`, hlsPlaylistUrl: `https://live.${OLD}/streams/p/playlist.m3u8` }).returning()
    const el = await createElement(preset.id, { type: 'model', properties: { a: { src: `https://cdn.${OLD}/m.glb` } } })
    const [world] = await db.insert(hyperfyWorlds).values({ sceneId: scene.id, ownerId: u.id, name: 'w', keyHash: 'h', keyPrefix: 'p', address: `moon.worlds.${OLD}` }).returning()
    return { asset, media, stream, el, world }
  }

  it('dry run counts but changes nothing', async () => {
    const { asset } = await seed()
    const counts = await rewriteStoredUrls(client, { apply: false })
    expect(counts['asset_library_items.cdn_url']).toBe(1)
    expect(counts['scene_elements.properties']).toBe(1)
    const [row] = await db.select().from(assetLibraryItems).where(eq(assetLibraryItems.id, asset.id))
    expect(row.cdnUrl).toBe(`https://cdn.${OLD}/a.glb`)
  })

  it('rewrites every listed column, keeps one retired copy per value, and changes nothing on a second run', async () => {
    const { asset, media, stream, el, world } = await seed()
    const first = await rewriteStoredUrls(client, { apply: true })
    expect(Object.values(first).reduce((a: number, b) => a + (b as number), 0)).toBe(7)

    expect((await db.select().from(assetLibraryItems).where(eq(assetLibraryItems.id, asset.id)))[0]).toMatchObject({ cdnUrl: 'https://cdn.virvi.io/a.glb', thumbnailUrl: 'https://cdn.virvi.io/a.png' })
    expect((await db.select().from(mediaAssets).where(eq(mediaAssets.id, media.id)))[0].publicUrl).toBe('https://cdn.virvi.io/m.png')
    expect((await db.select().from(streamingServers).where(eq(streamingServers.id, stream.id)))[0]).toMatchObject({ rtmpUrl: 'rtmp://ingest.virvi.io/live', hlsPlaylistUrl: 'https://live.virvi.io/streams/p/playlist.m3u8' })
    expect((await db.select().from(sceneElements).where(eq(sceneElements.id, el.id)))[0].properties).toEqual({ a: { src: 'https://cdn.virvi.io/m.glb' } })
    expect((await db.select().from(hyperfyWorlds).where(eq(hyperfyWorlds.id, world.id)))[0].address).toBe('moon.worlds.virvi.io')

    const second = await rewriteStoredUrls(client, { apply: true })
    expect(Object.values(second).every((n) => n === 0)).toBe(true)
    const [{ n }] = await client`SELECT count(*)::int AS n FROM retired.legacy_url_rewrite_20261026`
    expect(n).toBe(7)
  })
})
