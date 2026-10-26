import { describe, it, expect, vi } from 'vitest'
import { SceneManager } from '../src/SceneManager.js'
import { VLMStorageImpl } from '../src/storage.js'
import { EventBus } from '../src/events/EventBus.js'

function setup() {
  let next = 1
  const adapter: any = {
    capabilities: { video: true, platformName: 'test' },
    createEntity: vi.fn(() => next++),
    destroyEntity: vi.fn(),
    setTransform: vi.fn(),
    setPlaneRenderer: vi.fn(),
    setMaterial: vi.fn(),
    setCollider: vi.fn(),
    removeCollider: vi.fn(),
    createVideoPlayer: vi.fn(),
  }
  const storage = VLMStorageImpl.create()
  const sm = new SceneManager(adapter, storage, new EventBus())
  return { adapter, storage, sm }
}

const inst = { sk: 'i1', enabled: true, position: { x: 1, y: 1, z: 1 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }
const video = (extra: Record<string, unknown> = {}) => ({
  sk: 'v1', name: 'Screen', enabled: true, enableLiveStream: true, liveSrc: 'https://live/a.m3u8',
  offType: 1, offImageSrc: 'https://img/off.png', playlist: [], instances: [inst], ...extra,
})

describe('video upsert keeps in-memory live state', () => {
  it('unchanged media fields: a live screen stays live (with the live URL) after an upsert', () => {
    const { sm, adapter } = setup()
    sm.handlePresetUpdate({ action: 'init', scenePreset: { videos: [video()] } })
    sm.handleVideoStatus({ elementId: 'v1', status: 'live', url: 'https://live/now.m3u8' })
    adapter.createVideoPlayer.mockClear()
    adapter.setMaterial.mockClear()

    // e.g. the instance was moved or the element renamed on the dashboard
    sm.handlePresetUpdate({ action: 'upsert', element: 'video', elementData: video({ name: 'Renamed', instances: [{ ...inst, position: { x: 5, y: 1, z: 1 } }] }) })
    expect(adapter.createVideoPlayer).toHaveBeenCalledTimes(1)
    expect(adapter.createVideoPlayer).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ src: 'https://live/now.m3u8', playing: true }))
    expect(adapter.setMaterial).not.toHaveBeenCalled()
  })

  it('changed media fields: state resets (shows the off image)', () => {
    const { sm, adapter } = setup()
    sm.handlePresetUpdate({ action: 'init', scenePreset: { videos: [video()] } })
    sm.handleVideoStatus({ elementId: 'v1', status: 'live', url: 'https://live/now.m3u8' })
    adapter.createVideoPlayer.mockClear()

    sm.handlePresetUpdate({ action: 'upsert', element: 'video', elementData: video({ liveSrc: 'https://live/other.m3u8' }) })
    expect(adapter.createVideoPlayer).not.toHaveBeenCalled()
    expect(adapter.setMaterial).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ textureSrc: 'https://img/off.png' }))
  })

  it('a disabled upsert removes the screen; re-enabling starts fresh', () => {
    const { sm, storage } = setup()
    sm.handlePresetUpdate({ action: 'init', scenePreset: { videos: [video()] } })
    sm.handlePresetUpdate({ action: 'upsert', element: 'video', elementData: video({ enabled: false }) })
    expect(storage.videos.configs.v1).toBeUndefined()
    expect(Object.keys(storage.videos.instances)).toEqual([])
  })
})
