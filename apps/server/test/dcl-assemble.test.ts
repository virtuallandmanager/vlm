import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { config } from '../src/config.js'
import { db } from '../src/db/connection.js'
import { assetLibraryItems } from '../src/db/schema.js'
import {
  assembleFresh, assembleRedeploy, modelsInScene, pendingModels, wizardSceneJson, defaultModelFetcher,
  type ModelNeed,
} from '../src/services/dcl/assemble.js'
import { dclHash } from '../src/services/dcl/entity.js'
import { runtimeFiles, DCL_RUNTIME_VERSION } from '../src/services/dcl/runtime.js'
import type { LiveEntity } from '../src/services/dcl/worlds-client.js'
import { createUser, createScene, createElement } from './helpers/factories.js'

const CDN = 'https://cdn.virvi.test'
const enc = (s: string) => new TextEncoder().encode(s)
const need = (n: string, url = `${CDN}/m/${n}.glb`): ModelNeed => ({
  elementId: n, name: n, url, file: `models/vlm/${n}.glb`, triangles: 100, bytes: 10,
})

let savedCdn: string | null
beforeEach(() => { savedCdn = config.cdnUrl; (config as { cdnUrl: string | null }).cdnUrl = CDN })
afterEach(() => { (config as { cdnUrl: string | null }).cdnUrl = savedCdn })

const fetcher = () => vi.fn(async (url: string) => enc(`bytes of ${url}`))

async function live(over: Partial<LiveEntity['metadata']> = {}, runtime = 1): Promise<LiveEntity> {
  const rt = (await runtimeFiles(1)).get('bin/index.js')!
  const meta = { ...wizardSceneJson({ title: 'T', world: 'w.dcl.eth', base: '0,0', parcels: ['0,0'], spawn: { x: 8, y: 0, z: 8 } }), ...over }
  if (meta.virvi) meta.virvi = { ...meta.virvi, runtime }
  return {
    id: 'bafyold', pointers: ['0,0'], metadata: meta,
    content: [
      { file: 'bin/index.js', hash: await dclHash(rt) },
      { file: 'scene.json', hash: await dclHash(enc('scene')) },
      { file: 'models/vlm/a.glb', hash: await dclHash(enc('a')) },
    ],
  }
}

describe('assembleRedeploy', () => {
  it('uploads only models that are not already live', async () => {
    const l = await live()
    const f = fetcher()
    const r = await assembleRedeploy({ live: l, adopted: false, models: [need('a'), need('b')], timestamp: 1, fetch: f })
    expect(f).toHaveBeenCalledTimes(1)
    expect(r.added).toEqual(['models/vlm/b.glb'])
    expect(r.pointers).toEqual(['0,0'])
    expect(r.deployedFiles).toEqual(['bin/index.js', 'models/vlm/a.glb', 'models/vlm/b.glb', 'scene.json'])
    for (const c of l.content) expect(r.existing).toContainEqual(c)
    expect(r.newFileSources).toEqual([{ file: 'models/vlm/b.glb', hash: await dclHash(enc(`bytes of ${CDN}/m/b.glb`)), url: `${CDN}/m/b.glb` }])
    expect(r.files.size).toBe(2) // entity file + b
    expect(r.triangles).toBe(200)
  })

  it('leaves adopted scenes (no virvi block) untouched', async () => {
    const l = await live()
    delete (l.metadata as { virvi?: unknown }).virvi
    const before = JSON.stringify(l.metadata)
    const r = await assembleRedeploy({ live: l, adopted: true, models: [need('a')], timestamp: 1, fetch: fetcher() })
    expect(r.added).toEqual([])
    expect(r.existing.find((c) => c.file === 'bin/index.js')).toEqual(l.content[0])
    expect(JSON.stringify(r.metadata)).toBe(before)
  })

  it('upgrades the runtime of a wizard scene on an older version', async () => {
    const l = await live({}, 0)
    l.content[0].hash = await dclHash(enc('old runtime'))
    const r = await assembleRedeploy({ live: l, adopted: false, models: [need('a')], timestamp: 1, fetch: fetcher() })
    const newHash = await dclHash((await runtimeFiles()).get('bin/index.js')!)
    expect(r.existing.find((c) => c.file === 'bin/index.js')).toBeUndefined()
    expect(r.files.has(newHash)).toBe(true)
    expect(r.metadata.virvi?.runtime).toBe(DCL_RUNTIME_VERSION)
    expect(r.deployedFiles).toContain('bin/index.js')
  })

  it('refuses foreign and private model hosts without fetching them', async () => {
    const f = fetcher()
    const r = await assembleRedeploy({
      live: await live(), adopted: false, timestamp: 1, fetch: f,
      models: [need('evil', 'https://evil.example/x.glb'), need('priv', 'https://10.0.0.1/x.glb'), need('http', 'http://cdn.virvi.test/x.glb'), need('ok')],
    })
    expect(r.refused.map((x) => x.name)).toEqual(['evil', 'priv', 'http'])
    expect(r.refused.every((x) => x.reason.length > 0)).toBe(true)
    expect(f).toHaveBeenCalledTimes(1)
    expect(r.added).toEqual(['models/vlm/ok.glb'])
  })
})

describe('assembleFresh', () => {
  it('holds exactly the runtime, scene.json and one file per model', async () => {
    const metadata = wizardSceneJson({ title: 'T', world: 'w.dcl.eth', base: '0,0', parcels: ['0,0', '1,0'], spawn: { x: 8, y: 0, z: 8 } })
    const r = await assembleFresh({ metadata, models: [need('a'), need('b')], timestamp: 1, fetch: fetcher() })
    expect(r.deployedFiles).toEqual(['bin/index.js', 'models/vlm/a.glb', 'models/vlm/b.glb', 'scene.json'])
    expect(r.added).toEqual(['models/vlm/a.glb', 'models/vlm/b.glb'])
    expect(r.pointers).toEqual(['0,0', '1,0'])
    expect(r.existing).toEqual([])
    const sceneHash = await dclHash(enc(JSON.stringify(metadata)))
    const sceneJson = JSON.parse(new TextDecoder().decode(r.files.get(sceneHash)!))
    expect(sceneJson.worldConfiguration.name).toBe('w.dcl.eth')
    expect(sceneJson.scene.parcels).toEqual(['0,0', '1,0'])
  })

  it('wizardSceneJson points the runtime at this server', () => {
    const m = wizardSceneJson({ title: 'T', world: 'w', base: '0,0', parcels: ['0,0'], spawn: { x: 1, y: 0, z: 2 } })
    expect(m).toMatchObject({ main: 'bin/index.js', ecs7: true, runtimeVersion: '7', virvi: { runtime: DCL_RUNTIME_VERSION, apiUrl: config.publicUrl } })
    expect(m.virvi!.wssUrl).toMatch(/^wss?:\/\//)
    expect(m.spawnPoints).toHaveLength(1)
  })
})

describe('defaultModelFetcher', () => {
  it('refuses foreign hosts and plain http', async () => {
    await expect(defaultModelFetcher('https://evil.example/x.glb')).rejects.toMatchObject({ name: 'ModelRefused' })
    await expect(defaultModelFetcher('http://cdn.virvi.test/x.glb')).rejects.toMatchObject({ name: 'ModelRefused' })
  })
})

describe('modelsInScene / pendingModels', () => {
  it('reads the active preset, de-duplicates and fills sizes', async () => {
    const user = await createUser()
    const { scene, preset } = await createScene(user)
    const url = `${CDN}/m/Chair.glb`
    await db.insert(assetLibraryItems).values({ name: 'Chair', cdnUrl: url, storageKey: 'k', fileSizeBytes: 1234, triangleCount: 99 } as never)
    await createElement(preset.id, { type: 'model', name: 'Chair', properties: { modelSrc: url } })
    await createElement(preset.id, { type: 'model', name: 'Chair 2', properties: { modelSrc: url } })
    await createElement(preset.id, { type: 'model', name: 'Bad', properties: { modelSrc: 'https://x.example/thing.fbx' } })
    await createElement(preset.id, { type: 'model', name: 'Other', properties: { modelSrc: `${CDN}/m/Table.glb` } })
    const models = await modelsInScene(scene.id)
    expect(models.map((m) => m.file)).toEqual(['models/vlm/Chair.glb', 'models/vlm/Table.glb'])
    expect(models[0]).toMatchObject({ triangles: 99, bytes: 1234 })
    expect(models[1]).toMatchObject({ triangles: null, bytes: null })
    const pending = await pendingModels({ sceneId: scene.id, deployedFiles: ['MODELS/VLM/chair.glb'] })
    expect(pending.map((m) => m.file)).toEqual(['models/vlm/Table.glb'])
  })
})
