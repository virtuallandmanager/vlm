// apps/server/test/stream-live.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { db } from '../src/db/connection.js'
import { scenePresets, streamingServers } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { createUser, createScene, createElement, tokenFor, testApp } from './helpers/factories.js'
import { startGameServer, joinScene } from './helpers/game-server.js'

const KEY = 'test-webhook-secret'
const URL_A = 'https://live.vlm.gg/streams/ka/playlist.m3u8'
const URL_B = 'https://live.vlm.gg/streams/kb/playlist.m3u8'
const video = (presetId: string, liveSrc: string, name = 'Screen') =>
  createElement(presetId, { type: 'video', name, properties: { liveSrc, enableLiveStream: true, offType: 1, offImageSrc: 'https://x/off.png', playlist: [] } })

describe('stream live status in scene rooms', () => {
  let gs: Awaited<ReturnType<typeof startGameServer>>
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => {
    await resetDb()
    process.env.STREAMING_WEBHOOK_KEY = KEY
    gs = await startGameServer()
    app = await testApp()
  })
  afterEach(async () => {
    delete process.env.STREAMING_WEBHOOK_KEY
    await app.close()
    await gs.stop()
  })
  const webhook = (streamKey: string, status: 'live' | 'offline') =>
    app.inject({ method: 'POST', url: '/api/streaming/webhook', headers: { 'x-webhook-key': KEY }, payload: { streamKey, status } })
  async function provision(ownerId: string, key: string, url: string) {
    await db.insert(streamingServers).values({ ownerId, name: key, status: 'ready', streamKey: key, rtmpUrl: `rtmp://ingest.vlm.gg/live/${key}`, hlsPlaylistUrl: url })
  }

  it('live/offline reach every matching active-preset screen in every scene, and nothing else', async () => {
    const host = await createUser()
    await provision(host.id, 'ka', URL_A)
    const s1 = await createScene(host)
    const s2 = await createScene(host)
    const a1 = await video(s1.preset.id, URL_A, 'Main')
    const a2 = await video(s1.preset.id, `  ${URL_A} `, 'Side') // pasted with whitespace
    await video(s1.preset.id, URL_B, 'Other')
    const [inactive] = await db.insert(scenePresets).values({ sceneId: s1.scene.id, name: 'Inactive' }).returning()
    await video(inactive.id, URL_A, 'Hidden')
    const b1 = await video(s2.preset.id, URL_A)

    const c1 = await joinScene(gs.url, s1.scene.id, tokenFor(host))
    const c2 = await joinScene(gs.url, s2.scene.id)
    await c1.waitFor('scene_preset_update')
    await c2.waitFor('scene_preset_update')

    expect((await webhook('ka', 'live')).statusCode).toBe(200)
    const got = [await c1.waitFor('scene_video_status'), await c1.waitFor('scene_video_status')]
    expect(got.map((m) => m.elementId).sort()).toEqual([a1.id, a2.id].sort())
    for (const m of got) expect(m).toMatchObject({ status: 'live', url: URL_A })
    await c1.expectNone('scene_video_status', 300)
    expect(await c2.waitFor('scene_video_status')).toEqual({ elementId: b1.id, status: 'live', url: URL_A })

    await webhook('ka', 'offline')
    expect(await c2.waitFor('scene_video_status')).toEqual({ elementId: b1.id, status: 'offline', url: URL_A })
  })

  it('a client joining mid-stream gets isLive on the matching video only', async () => {
    const host = await createUser()
    await provision(host.id, 'ka', URL_A)
    const { scene, preset } = await createScene(host)
    const a = await video(preset.id, URL_A)
    const b = await video(preset.id, URL_B, 'Other')
    await webhook('ka', 'live')
    const c = await joinScene(gs.url, scene.id)
    const init = await c.waitFor('scene_preset_update')
    const byId = Object.fromEntries(init.scenePreset.videos.map((v: any) => [v.sk, v]))
    expect(byId[a.id].isLive).toBe(true)
    expect(byId[b.id].isLive).toBeUndefined()
  })

  it('an upsert during a stream keeps isLive', async () => {
    const host = await createUser()
    await provision(host.id, 'ka', URL_A)
    const { scene, preset } = await createScene(host)
    const a = await video(preset.id, URL_A)
    await webhook('ka', 'live')
    const c = await joinScene(gs.url, scene.id, tokenFor(host))
    await c.waitFor('scene_preset_update')
    await app.inject({ method: 'PUT', url: `/api/elements/${a.id}`, headers: { authorization: `Bearer ${tokenFor(host)}` }, payload: { name: 'Renamed' } })
    const msg = await c.waitFor('scene_preset_update')
    expect(msg).toMatchObject({ action: 'upsert', element: 'video', elementData: { sk: a.id, name: 'Renamed', isLive: true } })
  })
})
