import type { VLMPlatformAdapter, VLMStorage } from 'vlm-shared'
import { VideoManager } from './managers/VideoManager.js'
import { ImageManager } from './managers/ImageManager.js'
import { MeshManager } from './managers/MeshManager.js'
import { SoundManager } from './managers/SoundManager.js'
import { EventBus } from './events/EventBus.js'

// Manager interface — shared by all element managers
interface ElementManager {
  init(elements: any[]): void
  create(elementData: any): void
  createInstance(elementData: any, instanceData: any): void
  update(elementId: string, property: string, value: unknown): void
  updateInstance(instanceId: string, property: string, value: unknown): void
  updateElement(elementData: any): void
  updateInstanceData(instanceData: any): void
  delete(elementId: string): void
  deleteInstance(instanceId: string): void
  clear(): void
}

export class SceneManager {
  private managers: Record<string, ElementManager>
  private events: EventBus

  constructor(adapter: VLMPlatformAdapter, storage: VLMStorage, events: EventBus) {
    this.events = events
    this.managers = {
      video: new VideoManager(adapter, storage),
      image: new ImageManager(adapter, storage),
      model: new MeshManager(adapter, storage),
      sound: new SoundManager(adapter, storage),
    }
  }

  handlePresetUpdate(message: any): void {
    switch (message.action) {
      case 'init':
        this.initPreset(message.scenePreset)
        break
      case 'create':
        if (message.instance) {
          this.managers[message.element]?.createInstance(message.elementData, message.instanceData)
        } else {
          this.managers[message.element]?.create(message.elementData)
        }
        break
      case 'update':
        if (message.instance) {
          if (message.instanceData) {
            this.managers[message.element]?.updateInstanceData(message.instanceData)
          } else {
            this.managers[message.element]?.updateInstance(message.id, message.property, message.value)
          }
        } else {
          if (message.elementData) {
            this.managers[message.element]?.updateElement(message.elementData)
          } else {
            this.managers[message.element]?.update(message.id, message.property, message.value)
          }
        }
        break
      case 'delete':
        if (message.instance) {
          const instanceId = message.instanceData?.sk || message.id
          this.managers[message.element]?.deleteInstance(instanceId)
        } else {
          const elementId = message.elementData?.sk || message.id
          this.managers[message.element]?.delete(elementId)
        }
        break
    }
  }

  handlePresetChange(message: any): void {
    // Clear all current elements
    for (const manager of Object.values(this.managers)) {
      manager.clear()
    }
    // Re-init with new preset
    if (message.scenePreset) {
      this.initPreset(message.scenePreset)
    }
  }

  handleVideoStatus(message: any): void {
    const videoManager = this.managers.video as VideoManager
    videoManager.updateLiveStatus(message.elementId, message.status, message.url)
  }

  private initPreset(preset: any): void {
    if (!preset) return
    this.managers.video?.init(preset.videos || [])
    this.managers.image?.init(preset.images || [])
    this.managers.model?.init(preset.models || [])
    this.managers.sound?.init(preset.sounds || [])
  }
}
