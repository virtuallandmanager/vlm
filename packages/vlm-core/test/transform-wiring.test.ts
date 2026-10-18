import { describe, it, expect, vi } from 'vitest'
import { SceneManager } from '../src/SceneManager.js'
import { VLMStorageImpl } from '../src/storage.js'
import { EventBus } from '../src/events/EventBus.js'
import { VLM } from '../src/VLM.js'

function fakeAdapter() {
  let next = 1
  const live = new Set<number>()
  const adapter: any = {
    capabilities: { gltfModels: true, platformName: 'test' },
    createEntity: vi.fn(() => { const e = next++; live.add(e); return e }),
    destroyEntity: vi.fn((e: number) => { live.delete(e) }),
    entityExists: vi.fn((e: number) => live.has(e)),
    setTransform: vi.fn(), setPlaneRenderer: vi.fn(), setGltfModel: vi.fn(), setMaterial: vi.fn(),
    setCollider: vi.fn(), removeCollider: vi.fn(), onPointerDown: vi.fn(), removePointerEvents: vi.fn(),
    registerSystem: vi.fn(), unregisterSystem: vi.fn(),
  }
  return { adapter, live }
}

const T = (x: number) => ({ position: { x, y: 1, z: 2 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } })
const inst = (sk: string, x = 0) => ({ sk, enabled: true, ...T(x) })
const preset = { images: [{ sk: 'img1', name: 'Pic', enabled: true, textureSrc: 'a.png', instances: [inst('i1', 3)] }] }

function setupScene() {
  const { adapter, live } = fakeAdapter()
  const storage = VLMStorageImpl.create()
  const sm = new SceneManager(adapter, storage, new EventBus())
  sm.handlePresetUpdate({ action: 'init', scenePreset: preset })
  return { adapter, live, storage, sm }
}

function setupVlm(room: any | null) {
  const { adapter } = fakeAdapter()
  const vlm = new VLM(adapter)
  const colyseus: any = (vlm as any).colyseus
  ;(vlm as any).registerMessageHandlers()
  colyseus.room = room
  const fire = (type: string, msg: unknown) => { for (const h of colyseus.messageHandlers.get(type) ?? []) h(msg) }
  ;(vlm as any).sceneManager.handlePresetUpdate({ action: 'init', scenePreset: preset })
  return { vlm, adapter, fire }
}

describe('SceneManager transform wiring', () => {
  it('previewTransform calls setTransform and leaves storage unchanged', () => {
    const { sm, adapter, storage } = setupScene()
    adapter.setTransform.mockClear()
    sm.previewTransform('image', 'i1', T(9))
    expect(adapter.setTransform).toHaveBeenCalledWith(expect.anything(), T(9))
    expect(storage.images.instances.i1.position.x).toBe(3)
  })

  it('restoreTransform re-applies the stored transform; unknown sk is a no-op', () => {
    const { sm, adapter } = setupScene()
    sm.previewTransform('image', 'i1', T(9))
    adapter.setTransform.mockClear()
    sm.restoreTransform('image', 'i1')
    expect(adapter.setTransform).toHaveBeenCalledWith(expect.anything(), T(3))
    adapter.setTransform.mockClear()
    sm.restoreTransform('image', 'nope')
    expect(adapter.setTransform).not.toHaveBeenCalled()
  })

  it('findByEntity maps an image entity to its element, sk and name', () => {
    const { sm, live } = setupScene()
    const entity = [...live][0]
    expect(sm.findByEntity(entity)).toMatchObject({ element: 'image', sk: 'i1', name: 'Pic' })
    expect(sm.findByEntity(999)).toBeNull()
  })

  it('listEditable returns only instances with a live entity', () => {
    const { sm, live } = setupScene()
    expect(sm.listEditable()).toHaveLength(1)
    live.clear()
    expect(sm.listEditable()).toHaveLength(0)
  })
})

describe('VLM.editing', () => {
  it('an incoming transform_draft previews and emits; draft_end saved:false restores', () => {
    const { vlm, adapter, fire } = setupVlm({ sessionId: 'me', send: vi.fn() })
    const seen = vi.fn()
    vlm.events.on('transform_draft', seen)
    adapter.setTransform.mockClear()
    fire('transform_draft', { element: 'image', sk: 'i1', ...T(9), holderName: 'Bob', holderSessionId: 'other' })
    expect(adapter.setTransform).toHaveBeenCalledWith(expect.anything(), T(9))
    expect(seen).toHaveBeenCalledOnce()
    adapter.setTransform.mockClear()
    fire('transform_draft_end', { sk: 'i1', saved: false })
    expect(adapter.setTransform).toHaveBeenCalledWith(expect.anything(), T(3))
  })

  it('ignores a draft held by our own session', () => {
    const { vlm, adapter, fire } = setupVlm({ sessionId: 'me', send: vi.fn() })
    const seen = vi.fn()
    vlm.events.on('transform_draft', seen)
    adapter.setTransform.mockClear()
    fire('transform_draft', { element: 'image', sk: 'i1', ...T(9), holderName: 'Me', holderSessionId: 'me' })
    expect(adapter.setTransform).not.toHaveBeenCalled()
    expect(seen).not.toHaveBeenCalled()
  })

  it('transform_held is emitted; saved draft_end does not restore', () => {
    const { vlm, adapter, fire } = setupVlm({ sessionId: 'me', send: vi.fn() })
    const held = vi.fn(); const ended = vi.fn()
    vlm.events.on('transform_held', held)
    vlm.events.on('transform_draft_end', ended)
    fire('transform_held', { sk: 'i1', holderName: 'Bob' })
    adapter.setTransform.mockClear()
    fire('transform_draft_end', { sk: 'i1', saved: true })
    expect(held).toHaveBeenCalledWith({ sk: 'i1', holderName: 'Bob' })
    expect(ended).toHaveBeenCalled()
    expect(adapter.setTransform).not.toHaveBeenCalled()
  })

  it('save with no room throws not_connected and changes nothing', () => {
    const { vlm, adapter } = setupVlm(null)
    adapter.setTransform.mockClear()
    expect(() => vlm.editing.save('image', 'i1', T(9))).toThrow('not_connected')
    expect(adapter.setTransform).not.toHaveBeenCalled()
    expect(vlm.storage.images.instances.i1.position.x).toBe(3)
  })

  it('save sends scene_preset_update and applies locally', () => {
    const send = vi.fn()
    const { vlm, adapter } = setupVlm({ sessionId: 'me', send })
    adapter.setTransform.mockClear()
    vlm.editing.save('image', 'i1', T(9))
    expect(send).toHaveBeenCalledWith('scene_preset_update', {
      action: 'update', element: 'image', instance: true,
      instanceData: { sk: 'i1', position: T(9).position, rotation: T(9).rotation, scale: T(9).scale },
    })
    expect(adapter.setTransform).toHaveBeenCalledWith(expect.anything(), T(9))
    expect(vlm.storage.images.instances.i1.position.x).toBe(9)
  })

  it('sendDraft and endDraft send the protocol messages', () => {
    const send = vi.fn()
    const { vlm } = setupVlm({ sessionId: 'me', send })
    const d = { element: 'image' as const, sk: 'i1', ...T(5) }
    vlm.editing.sendDraft(d)
    vlm.editing.endDraft('i1', false)
    expect(send).toHaveBeenNthCalledWith(1, 'transform_draft', d)
    expect(send).toHaveBeenNthCalledWith(2, 'transform_end', { sk: 'i1', saved: false })
  })
})
