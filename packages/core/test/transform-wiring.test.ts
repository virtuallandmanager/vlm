import { describe, it, expect, vi, afterEach } from 'vitest'
import { SceneManager } from '../src/SceneManager.js'
import { VirviStorageImpl } from '../src/storage.js'
import { EventBus } from '../src/events/EventBus.js'
import { Virvi } from '../src/Virvi.js'

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
    systems: new Set<(dt: number) => void>(),
    registerSystem: vi.fn((fn: (dt: number) => void) => adapter.systems.add(fn)),
    unregisterSystem: vi.fn((fn: (dt: number) => void) => adapter.systems.delete(fn)),
  }
  return { adapter, live }
}

const T = (x: number) => ({ position: { x, y: 1, z: 2 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } })
const inst = (sk: string, x = 0) => ({ sk, enabled: true, ...T(x) })
const preset = { images: [{ sk: 'img1', name: 'Pic', enabled: true, textureSrc: 'a.png', instances: [inst('i1', 3)] }] }

function setupScene() {
  const { adapter, live } = fakeAdapter()
  const storage = VirviStorageImpl.create()
  const sm = new SceneManager(adapter, storage, new EventBus())
  sm.handlePresetUpdate({ action: 'init', scenePreset: preset })
  return { adapter, live, storage, sm }
}

function setupVirvi(room: any | null) {
  const { adapter } = fakeAdapter()
  const virvi = new Virvi(adapter)
  const colyseus: any = (virvi as any).colyseus
  ;(virvi as any).registerMessageHandlers()
  colyseus.room = room
  const fire = (type: string, msg: unknown) => { for (const h of colyseus.messageHandlers.get(type) ?? []) h(msg) }
  ;(virvi as any).sceneManager.handlePresetUpdate({ action: 'init', scenePreset: preset })
  const tick = () => { for (const fn of [...adapter.systems]) fn(0.016) }
  return { virvi, adapter, fire, tick, colyseus }
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

const openRoom = (send = vi.fn()) => ({ sessionId: 'me', send, connection: { isOpen: true } })
const instanceSave = (x: number) => ({
  action: 'update', element: 'image', instance: true,
  instanceData: { sk: 'i1', position: T(x).position, rotation: T(x).rotation, scale: T(x).scale },
})

describe('Virvi.editing', () => {
  afterEach(() => { vi.useRealTimers() })

  it('an incoming transform_draft previews and emits; draft_end saved:false restores', () => {
    const { virvi, adapter, fire } = setupVirvi(openRoom())
    const seen = vi.fn()
    virvi.events.on('transform_draft', seen)
    adapter.setTransform.mockClear()
    fire('transform_draft', { element: 'image', sk: 'i1', ...T(9), holderName: 'Bob', holderSessionId: 'other' })
    expect(adapter.setTransform).toHaveBeenCalledWith(expect.anything(), T(9))
    expect(seen).toHaveBeenCalledOnce()
    adapter.setTransform.mockClear()
    fire('transform_draft_end', { sk: 'i1', saved: false })
    expect(adapter.setTransform).toHaveBeenCalledWith(expect.anything(), T(3))
  })

  it('ignores a draft held by our own session', () => {
    const { virvi, adapter, fire } = setupVirvi(openRoom())
    const seen = vi.fn()
    virvi.events.on('transform_draft', seen)
    adapter.setTransform.mockClear()
    fire('transform_draft', { element: 'image', sk: 'i1', ...T(9), holderName: 'Me', holderSessionId: 'me' })
    expect(adapter.setTransform).not.toHaveBeenCalled()
    expect(seen).not.toHaveBeenCalled()
  })

  it('transform_held is emitted; saved draft_end does not restore', () => {
    const { virvi, adapter, fire } = setupVirvi(openRoom())
    const held = vi.fn(); const ended = vi.fn()
    virvi.events.on('transform_held', held)
    virvi.events.on('transform_draft_end', ended)
    fire('transform_held', { sk: 'i1', holderName: 'Bob' })
    adapter.setTransform.mockClear()
    fire('transform_draft_end', { sk: 'i1', saved: true })
    expect(held).toHaveBeenCalledWith({ sk: 'i1', holderName: 'Bob' })
    expect(ended).toHaveBeenCalled()
    expect(adapter.setTransform).not.toHaveBeenCalled()
  })

  it('save with no room rejects not_connected and changes nothing', async () => {
    const { virvi, adapter } = setupVirvi(null)
    adapter.setTransform.mockClear()
    await expect(virvi.editing.save('image', 'i1', T(9))).rejects.toThrow('not_connected')
    expect(adapter.setTransform).not.toHaveBeenCalled()
    expect(virvi.storage.images.instances.i1.position.x).toBe(3)
  })

  it('a room whose connection is closed counts as not connected: save rejects, sendDraft drops silently', async () => {
    const send = vi.fn()
    const { virvi, adapter } = setupVirvi({ sessionId: 'me', send, connection: { isOpen: false } })
    adapter.setTransform.mockClear()
    await expect(virvi.editing.save('image', 'i1', T(9))).rejects.toThrow('not_connected')
    expect(() => virvi.editing.sendDraft({ element: 'image', sk: 'i1', ...T(5) })).not.toThrow()
    expect(send).not.toHaveBeenCalled()
    expect(adapter.setTransform).not.toHaveBeenCalled()
    expect(virvi.storage.images.instances.i1.position.x).toBe(3)
  })

  it('save sends scene_preset_update and applies locally only on the ack for this instance', async () => {
    const send = vi.fn()
    const { virvi, adapter, fire } = setupVirvi(openRoom(send))
    adapter.setTransform.mockClear()
    const saved = vi.fn()
    const p = virvi.editing.save('image', 'i1', T(9)).then(saved)
    expect(send).toHaveBeenCalledWith('scene_preset_update', instanceSave(9))
    await Promise.resolve()
    expect(saved).not.toHaveBeenCalled()
    expect(virvi.storage.images.instances.i1.position.x).toBe(3)
    fire('scene_preset_update_ack', { action: 'update', sk: 'other' })
    fire('scene_preset_update_ack', { action: 'update', id: 'img1' }) // an element ack, not ours
    await Promise.resolve()
    expect(saved).not.toHaveBeenCalled()
    fire('scene_preset_update_ack', { action: 'update', sk: 'i1' })
    await p
    expect(saved).toHaveBeenCalledOnce()
    expect(adapter.setTransform).toHaveBeenCalledWith(expect.anything(), T(9))
    expect(virvi.storage.images.instances.i1.position.x).toBe(9)
  })

  it('a virvi_error for scene_preset_update rejects the save with its code and leaves storage unchanged', async () => {
    const { virvi, adapter, fire } = setupVirvi(openRoom())
    adapter.setTransform.mockClear()
    const p = virvi.editing.save('image', 'i1', T(9))
    fire('virvi_error', { code: 'rate_limited', messageType: 'transform_draft' }) // not ours
    fire('virvi_error', { code: 'forbidden', messageType: 'scene_preset_update' })
    await expect(p).rejects.toThrow('forbidden')
    fire('scene_preset_update_ack', { action: 'update', sk: 'i1' }) // a late ack applies nothing
    expect(adapter.setTransform).not.toHaveBeenCalled()
    expect(virvi.storage.images.instances.i1.position.x).toBe(3)
  })

  it('a save with no ack rejects save_timeout after 5 s and leaves storage unchanged', async () => {
    vi.useFakeTimers()
    const { virvi, adapter, tick } = setupVirvi(openRoom())
    const rejected = vi.fn()
    const p = virvi.editing.save('image', 'i1', T(9)).catch(rejected)
    vi.advanceTimersByTime(4900)
    tick()
    await Promise.resolve()
    expect(rejected).not.toHaveBeenCalled()
    vi.advanceTimersByTime(200)
    tick()
    await p
    expect(rejected).toHaveBeenCalledWith(new Error('save_timeout'))
    expect(virvi.storage.images.instances.i1.position.x).toBe(3)
    expect(adapter.systems.size).toBe(0) // the timeout check stops once nothing is pending
  })

  it('a dropped connection clears the room, rejects a pending save and emits connection_lost', async () => {
    const { adapter } = fakeAdapter()
    const virvi = new Virvi(adapter)
    const colyseus: any = (virvi as any).colyseus
    ;(virvi as any).registerMessageHandlers()
    ;(virvi as any).sceneManager.handlePresetUpdate({ action: 'init', scenePreset: preset })
    let leave: (code: number) => void = () => {}
    const room = { sessionId: 'me', send: vi.fn(), connection: { isOpen: true }, onMessage: vi.fn(), onLeave: (cb: any) => { leave = cb } }
    colyseus.client = { joinOrCreate: vi.fn(async () => room) }
    await colyseus.joinSceneRoom('scene1')
    const lost = vi.fn()
    virvi.events.on('connection_lost', lost)
    const p = virvi.editing.save('image', 'i1', T(9))
    room.connection.isOpen = false
    leave(1006)
    await expect(p).rejects.toThrow('not_connected')
    expect(colyseus.getRoom()).toBeNull()
    expect(lost).toHaveBeenCalledWith({ code: 1006 })
    await expect(virvi.editing.save('image', 'i1', T(9))).rejects.toThrow('not_connected')
    expect(virvi.storage.images.instances.i1.position.x).toBe(3)
  })

  it('an intentional leave does not emit connection_lost', async () => {
    const { adapter } = fakeAdapter()
    const virvi = new Virvi(adapter)
    const colyseus: any = (virvi as any).colyseus
    ;(virvi as any).registerMessageHandlers()
    let leave: (code: number) => void = () => {}
    const room = { sessionId: 'me', send: vi.fn(), connection: { isOpen: true }, onMessage: vi.fn(), onLeave: (cb: any) => { leave = cb }, leave: vi.fn() }
    colyseus.client = { joinOrCreate: vi.fn(async () => room) }
    await colyseus.joinSceneRoom('scene1')
    const lost = vi.fn()
    virvi.events.on('connection_lost', lost)
    colyseus.leaveRoom()
    leave(1000)
    expect(lost).not.toHaveBeenCalled()
  })

  it('sendDraft and endDraft send the protocol messages', () => {
    const send = vi.fn()
    const { virvi } = setupVirvi(openRoom(send))
    const d = { element: 'image' as const, sk: 'i1', ...T(5) }
    virvi.editing.sendDraft(d)
    virvi.editing.endDraft('i1', false)
    expect(send).toHaveBeenNthCalledWith(1, 'transform_draft', d)
    expect(send).toHaveBeenNthCalledWith(2, 'transform_end', { sk: 'i1', saved: false })
  })
})
