import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { scenes, scenePresets, streamingServers } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { createUser, createScene, createElement, tokenFor, testApp } from './helpers/factories.js'
import { startGameServer, joinScene } from './helpers/game-server.js'
import { onSceneTouched } from '../src/realtime/bus.js'
import { sceneSnapshot } from '../src/hyperfy/snapshot.js'

const URL_A = 'https://live.vlm.gg/streams/ka/playlist.m3u8'

describe('hyperfy scene snapshot and scene-touched signal', () => {
  let gs: Awaited<ReturnType<typeof startGameServer>>
  let app: Awaited<ReturnType<typeof testApp>>
  const unsubs: (() => Promise<void>)[] = []
  beforeEach(async () => {
    await resetDb()
    gs = await startGameServer()
    app = await testApp()
  })
  afterEach(async () => {
    while (unsubs.length) await unsubs.pop()!()
    delete process.env.STREAMING_WEBHOOK_KEY
    await app.close()
    await gs.stop()
  })

  async function watch(sceneId: string) {
    const counter = { n: 0 }
    unsubs.push(await onSceneTouched(sceneId, () => counter.n++))
    return counter
  }
  const until = async (fn: () => boolean, ms = 3000) => {
    const start = Date.now()
    while (!fn() && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 20))
    expect(fn()).toBe(true)
  }

  it('snapshot version changes when an element is edited through REST, and stays the same otherwise', async () => {
    const host = await createUser()
    const { scene, preset } = await createScene(host)
    const el = await createElement(preset.id, { type: 'image', name: 'Pic', properties: { textureSrc: 'https://x/a.png' } })
    const a = await sceneSnapshot(scene.id)
    const b = await sceneSnapshot(scene.id)
    expect(a!.scene!.images).toHaveLength(1)
    expect(a!.version).toMatch(/^[0-9a-f]{64}$/)
    expect(b).toEqual(a)
    const res = await app.inject({
      method: 'PUT',
      url: `/api/elements/${el.id}`,
      headers: { authorization: `Bearer ${tokenFor(host)}` },
      payload: { properties: { textureSrc: 'https://x/b.png' } },
    })
    expect(res.statusCode).toBe(200)
    const c = await sceneSnapshot(scene.id)
    expect(c!.version).not.toBe(a!.version)
    expect(await sceneSnapshot(scene.id)).toEqual(c)
  })

  it('onSceneTouched fires for a REST element edit, a preset switch, and an edit sent in a scene room', async () => {
    const host = await createUser()
    const headers = { authorization: `Bearer ${tokenFor(host)}` }
    const { scene, preset } = await createScene(host)
    const el = await createElement(preset.id, { type: 'image', name: 'Pic', properties: { textureSrc: 'https://x/a.png' } })
    const [other] = await db.insert(scenePresets).values({ sceneId: scene.id, name: 'Other' }).returning()
    const otherScene = await createScene(host)
    const seen = await watch(scene.id)
    const unrelated = await watch(otherScene.scene.id)

    await app.inject({ method: 'PUT', url: `/api/elements/${el.id}`, headers, payload: { name: 'Renamed' } })
    await until(() => seen.n === 1)

    const sw = await app.inject({ method: 'PUT', url: `/api/scenes/${scene.id}`, headers, payload: { activePresetId: other.id } })
    expect(sw.statusCode).toBe(200)
    await until(() => seen.n === 2)

    const c = await joinScene(gs.url, scene.id, tokenFor(host))
    await c.waitFor('scene_preset_update')
    c.room.send('scene_change_preset', { presetId: preset.id })
    await until(() => seen.n === 3)
    c.room.send('scene_preset_update', { action: 'update', element: 'image', elementData: { sk: el.id, textureSrc: 'https://x/c.png' } })
    await until(() => seen.n === 4)

    await new Promise((r) => setTimeout(r, 200))
    expect(seen.n).toBe(4)
    expect(unrelated.n).toBe(0)
    c.room.leave()
  })

  it('a stream going live touches scenes whose video uses that stream', async () => {
    process.env.STREAMING_WEBHOOK_KEY = 'k'
    const host = await createUser()
    await db.insert(streamingServers).values({ ownerId: host.id, name: 'ka', status: 'ready', streamKey: 'ka', rtmpUrl: 'rtmp://i/live/ka', hlsPlaylistUrl: URL_A })
    const using = await createScene(host)
    await createElement(using.preset.id, { type: 'video', name: 'Screen', properties: { liveSrc: ` ${URL_A} `, playlist: [] } })
    const notUsing = await createScene(host)
    await createElement(notUsing.preset.id, { type: 'video', name: 'Screen', properties: { liveSrc: 'https://other/x.m3u8', playlist: [] } })
    const before = (await sceneSnapshot(using.scene.id))!.version
    const hit = await watch(using.scene.id)
    const miss = await watch(notUsing.scene.id)

    const res = await app.inject({ method: 'POST', url: '/api/streaming/webhook', headers: { 'x-webhook-key': 'k' }, payload: { streamKey: 'ka', status: 'live' } })
    expect(res.statusCode).toBe(200)
    await until(() => hit.n === 1)
    expect((await sceneSnapshot(using.scene.id))!.version).not.toBe(before)
    await new Promise((r) => setTimeout(r, 200))
    expect(miss.n).toBe(0)
  })

  it('snapshot is null for a missing scene and has scene null with no active preset', async () => {
    expect(await sceneSnapshot(randomUUID())).toBeNull()
    const host = await createUser()
    const { scene } = await createScene(host)
    await db.update(scenes).set({ activePresetId: null }).where(eq(scenes.id, scene.id))
    const snap = await sceneSnapshot(scene.id)
    expect(snap!.scene).toBeNull()
    expect(snap!.version).toMatch(/^[0-9a-f]{64}$/)
  })
})
