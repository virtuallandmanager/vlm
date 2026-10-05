import { describe, it, expect, vi } from 'vitest'
import { SceneManager } from '../src/SceneManager.js'
import { VLMStorageImpl } from '../src/storage.js'
import { EventBus } from '../src/events/EventBus.js'
import { VLM } from '../src/VLM.js'

function fakeAdapter(extra: Record<string, unknown> = {}) {
  let next = 1
  const live = new Set<number>()
  const adapter: any = {
    capabilities: { gltfModels: true, platformName: 'test' },
    createEntity: vi.fn(() => { const e = next++; live.add(e); return e }),
    destroyEntity: vi.fn((e: number) => { live.delete(e) }),
    entityExists: vi.fn((e: number) => live.has(e)),
    setTransform: vi.fn(),
    setPlaneRenderer: vi.fn(),
    setGltfModel: vi.fn(),
    setMaterial: vi.fn(),
    setCollider: vi.fn(),
    removeCollider: vi.fn(),
    onPointerDown: vi.fn(),
    removePointerEvents: vi.fn(),
    ...extra,
  }
  return { adapter, live }
}

const inst = (sk: string, x = 0) => ({
  sk, enabled: true, position: { x, y: 1, z: 2 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
})

function setup(extra?: Record<string, unknown>) {
  const { adapter, live } = fakeAdapter(extra)
  const storage = VLMStorageImpl.create()
  const events = new EventBus()
  const sm = new SceneManager(adapter, storage, events)
  return { adapter, live, storage, events, sm }
}

describe('SceneManager upsert', () => {
  it('replaces an existing image: old instance entities removed, new ones created', () => {
    const { sm, adapter, live, storage } = setup()
    sm.handlePresetUpdate({
      action: 'init',
      scenePreset: { images: [{ sk: 'img1', name: 'A', enabled: true, textureSrc: 'a.png', instances: [inst('i1'), inst('i2')] }] },
    })
    expect(live.size).toBe(2)
    const oldEntities = [...live]

    sm.handlePresetUpdate({
      action: 'upsert',
      element: 'image',
      elementData: { sk: 'img1', name: 'B', enabled: true, textureSrc: 'b.png', instances: [inst('i3', 5)] },
    })

    for (const e of oldEntities) expect(live.has(e)).toBe(false)
    expect(live.size).toBe(1)
    expect(storage.images.configs.img1).toMatchObject({ name: 'B', textureSrc: 'b.png' })
    expect(Object.keys(storage.images.instances)).toEqual(['i3'])
    expect(adapter.setMaterial).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ textureSrc: 'b.png' }))
    expect(adapter.setTransform).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ position: { x: 5, y: 1, z: 2 } }))
  })

  it('creates an element it does not know yet', () => {
    const { sm, live, storage } = setup()
    sm.handlePresetUpdate({ action: 'init', scenePreset: {} })
    sm.handlePresetUpdate({
      action: 'upsert',
      element: 'image',
      elementData: { sk: 'new1', name: 'N', enabled: true, textureSrc: 'n.png', instances: [inst('n-i1')] },
    })
    expect(live.size).toBe(1)
    expect(storage.images.configs.new1).toBeDefined()
  })

  it('a disabled upsert removes the element without recreating it', () => {
    const { sm, live, storage } = setup()
    sm.handlePresetUpdate({
      action: 'init',
      scenePreset: { images: [{ sk: 'img1', enabled: true, textureSrc: 'a.png', instances: [inst('i1')] }] },
    })
    sm.handlePresetUpdate({ action: 'upsert', element: 'image', elementData: { sk: 'img1', enabled: false, instances: [inst('i1')] } })
    expect(live.size).toBe(0)
    expect(storage.images.configs.img1).toBeUndefined()
  })

  it('ignores upserts for element types without a manager', () => {
    const { sm } = setup()
    expect(() => sm.handlePresetUpdate({ action: 'upsert', element: 'nft', elementData: { sk: 'x' } })).not.toThrow()
  })
})

describe('model resolution via adapter.resolveModelSrc', () => {
  const model = (src: string, sk = 'm1') => ({ sk, name: 'M', enabled: true, modelSrc: src, instances: [inst(`${sk}-i1`)] })

  it('skips the entity and records it as missing when resolveModelSrc returns null', () => {
    const resolveModelSrc = vi.fn(() => null)
    const { adapter } = fakeAdapter({ resolveModelSrc })
    const vlm = new VLM(adapter)
    const counts: number[] = []
    ;(vlm as any).events.on('models_missing', (n: number) => counts.push(n))

    ;(vlm as any).sceneManager.handlePresetUpdate({
      action: 'init', scenePreset: { models: [model('https://cdn.vlm.gg/u1/ab12.glb')] },
    })

    expect(resolveModelSrc).toHaveBeenCalledWith('https://cdn.vlm.gg/u1/ab12.glb')
    expect(adapter.createEntity).not.toHaveBeenCalled()
    expect(adapter.setGltfModel).not.toHaveBeenCalled()
    expect(vlm.missingModels()).toBe(1)
    expect(counts).toEqual([1])
    expect(vlm.storage.models.missing.has('m1')).toBe(true)
  })

  it('clears the missing record when the element is deleted', () => {
    const { adapter } = fakeAdapter({ resolveModelSrc: () => null })
    const vlm = new VLM(adapter)
    const counts: number[] = []
    ;(vlm as any).events.on('models_missing', (n: number) => counts.push(n))
    const sm = (vlm as any).sceneManager
    sm.handlePresetUpdate({ action: 'init', scenePreset: { models: [model('https://cdn.vlm.gg/u1/ab12.glb')] } })
    sm.handlePresetUpdate({ action: 'delete', element: 'model', id: 'm1' })
    expect(vlm.missingModels()).toBe(0)
    expect(counts).toEqual([1, 0])
  })

  it('an upsert that now resolves creates the entity and clears missing', () => {
    let available = false
    const { adapter, live } = fakeAdapter({ resolveModelSrc: () => (available ? 'models/vlm/ab12.glb' : null) })
    const vlm = new VLM(adapter)
    const sm = (vlm as any).sceneManager
    sm.handlePresetUpdate({ action: 'init', scenePreset: { models: [model('https://cdn.vlm.gg/u1/ab12.glb')] } })
    expect(vlm.missingModels()).toBe(1)
    available = true
    sm.handlePresetUpdate({ action: 'upsert', element: 'model', elementData: model('https://cdn.vlm.gg/u1/ab12.glb') })
    expect(vlm.missingModels()).toBe(0)
    expect(live.size).toBe(1)
  })

  it('uses the resolved path as the GltfContainer src', () => {
    const { adapter } = fakeAdapter({ resolveModelSrc: () => 'models/vlm/ab12.glb' })
    const { sm } = (() => {
      const storage = VLMStorageImpl.create()
      return { sm: new SceneManager(adapter, storage, new EventBus()) }
    })()
    sm.handlePresetUpdate({ action: 'init', scenePreset: { models: [model('https://cdn.vlm.gg/u1/ab12.glb')] } })
    expect(adapter.createEntity).toHaveBeenCalledTimes(1)
    expect(adapter.setGltfModel).toHaveBeenCalledWith(expect.anything(), 'models/vlm/ab12.glb')
  })

  it('leaves modelSrc untouched when the adapter has no resolveModelSrc', () => {
    const { sm, adapter } = setup()
    sm.handlePresetUpdate({ action: 'init', scenePreset: { models: [model('models/local.glb')] } })
    expect(adapter.setGltfModel).toHaveBeenCalledWith(expect.anything(), 'models/local.glb')
  })

  it('upsert replaces model instances without leaking entities', () => {
    const { sm, live } = setup({ resolveModelSrc: (s: string) => s })
    sm.handlePresetUpdate({ action: 'init', scenePreset: { models: [model('models/a.glb')] } })
    sm.handlePresetUpdate({ action: 'upsert', element: 'model', elementData: model('models/b.glb') })
    sm.handlePresetUpdate({ action: 'upsert', element: 'model', elementData: model('models/c.glb') })
    expect(live.size).toBe(1)
  })
})

describe('VLM.onModelsMissing', () => {
  const model = (src: string, sk = 'm1') => ({ sk, name: 'M', enabled: true, modelSrc: src, instances: [inst(`${sk}-i1`)] })

  it('reports the latest missing count on each change and stops after unsubscribe', () => {
    const { adapter } = fakeAdapter({ resolveModelSrc: () => null })
    const vlm = new VLM(adapter)
    const counts: number[] = []
    const off = vlm.onModelsMissing((n) => counts.push(n))
    const sm = (vlm as any).sceneManager
    sm.handlePresetUpdate({ action: 'init', scenePreset: { models: [model('https://cdn.vlm.gg/u1/ab12.glb')] } })
    // An upsert of a still-missing model deletes then recreates: listeners always see the current count
    sm.handlePresetUpdate({ action: 'upsert', element: 'model', elementData: model('https://cdn.vlm.gg/u1/ab12.glb') })
    expect(counts).toEqual([1, 0, 1])
    expect(vlm.missingModels()).toBe(1)
    off()
    sm.handlePresetUpdate({ action: 'delete', element: 'model', id: 'm1' })
    expect(counts).toEqual([1, 0, 1])
  })
})
