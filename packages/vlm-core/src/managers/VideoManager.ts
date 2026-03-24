import type { VLMPlatformAdapter, VLMStorage, EntityHandle } from 'vlm-shared'

// Internal tracking of element config
interface VideoConfig {
  sk: string
  name: string
  enabled: boolean
  customId?: string
  liveSrc?: string
  isLive: boolean
  enableLiveStream: boolean
  offImageSrc?: string
  offType: number
  playlist: string[]
  volume: number
  playlistIndex: number
  emission: number
}

// Internal tracking of element instance -> entity mapping
interface VideoInstance {
  sk: string
  enabled: boolean
  customId?: string
  entity: EntityHandle
  configSk: string
  position: { x: number; y: number; z: number }
  rotation: { x: number; y: number; z: number }
  scale: { x: number; y: number; z: number }
  withCollisions: boolean
}

export class VideoManager {
  private adapter: VLMPlatformAdapter
  private storage: VLMStorage
  private configs: Map<string, VideoConfig> = new Map()
  private instances: Map<string, VideoInstance> = new Map()

  constructor(adapter: VLMPlatformAdapter, storage: VLMStorage) {
    this.adapter = adapter
    this.storage = storage
  }

  init(elements: any[]): void {
    if (!this.adapter.capabilities.video) return

    for (const element of elements) {
      if (!element.enabled) continue
      this.createConfig(element)
      for (const instance of element.instances || []) {
        if (!instance.enabled) continue
        this.createInstanceEntity(element.sk, instance)
      }
    }
  }

  private createConfig(data: any): void {
    const config: VideoConfig = {
      sk: data.sk,
      name: data.name || '',
      enabled: data.enabled ?? true,
      customId: data.customId,
      liveSrc: data.liveSrc,
      isLive: data.isLive ?? false,
      enableLiveStream: data.enableLiveStream ?? false,
      offImageSrc: data.offImageSrc,
      offType: data.offType ?? 0,
      playlist: data.playlist || [],
      volume: (data.volume ?? 100) / 100, // Convert 0-100 to 0-1
      playlistIndex: 0,
      emission: data.emission ?? 0.6,
    }
    this.configs.set(config.sk, config)

    // Register in storage (keyed by customId if available, else by sk)
    const key = config.customId || config.sk
    this.storage.videos.configs[key] = data
  }

  private createInstanceEntity(configSk: string, data: any): void {
    const config = this.configs.get(configSk)
    if (!config) return

    const entity = this.adapter.createEntity()

    const position = data.position || { x: 0, y: 0, z: 0 }
    const rotation = data.rotation || { x: 0, y: 0, z: 0 }
    const scale = data.scale || { x: 1, y: 1, z: 1 }

    // Set transform
    this.adapter.setTransform(entity, { position, rotation, scale })

    // Set plane mesh for the video screen
    this.adapter.setPlaneRenderer(entity)

    // Apply the correct media source
    this.applyMediaState(entity, config)

    // Set collider if needed
    if (data.withCollisions) {
      this.adapter.setCollider(entity, { type: 'box' })
    }

    // Track the instance
    const instance: VideoInstance = {
      sk: data.sk,
      enabled: data.enabled ?? true,
      customId: data.customId,
      entity,
      configSk,
      position,
      rotation,
      scale,
      withCollisions: data.withCollisions ?? false,
    }
    this.instances.set(data.sk, instance)

    // Register in storage
    const key = data.customId || data.sk
    this.storage.videos.instances[key] = data
  }

  private applyMediaState(entity: EntityHandle, config: VideoConfig): void {
    // Live stream mode
    if (config.isLive && config.enableLiveStream && config.liveSrc) {
      this.adapter.createVideoPlayer(entity, {
        src: config.liveSrc,
        playing: true,
        loop: true,
        volume: config.volume,
      })
      return
    }

    // Offline modes based on offType
    switch (config.offType) {
      case 2: // PLAYLIST
        if (config.playlist.length > 0) {
          const src = config.playlist[config.playlistIndex % config.playlist.length]
          this.adapter.createVideoPlayer(entity, {
            src,
            playing: true,
            loop: config.playlist.length === 1,
            volume: config.volume,
          })
        }
        break
      case 1: // IMAGE
        if (config.offImageSrc) {
          this.adapter.setMaterial(entity, {
            textureSrc: config.offImageSrc,
            emission: config.emission,
          })
        }
        break
      case 0: // NONE
      default:
        // No media to display
        break
    }
  }

  // Called when server broadcasts video status change
  updateLiveStatus(elementId: string, status: string, url?: string): void {
    const config = this.configs.get(elementId)
    if (!config) return

    const isLive = status === 'live'
    config.isLive = isLive
    if (url) {
      config.liveSrc = url
    }

    // Re-apply media state to all instances of this config
    for (const instance of this.instances.values()) {
      if (instance.configSk === elementId) {
        this.applyMediaState(instance.entity, config)
      }
    }
  }

  // CRUD operations
  create(elementData: any): void {
    this.createConfig(elementData)
    for (const inst of elementData.instances || []) {
      if (inst.enabled !== false) {
        this.createInstanceEntity(elementData.sk, inst)
      }
    }
  }

  createInstance(elementData: any, instanceData: any): void {
    const configSk = elementData?.sk || instanceData?.elementId
    this.createInstanceEntity(configSk, instanceData)
  }

  updateElement(elementData: any): void {
    const config = this.configs.get(elementData.sk)
    if (!config) return

    // Update config fields
    if (elementData.liveSrc !== undefined) config.liveSrc = elementData.liveSrc
    if (elementData.isLive !== undefined) config.isLive = elementData.isLive
    if (elementData.enableLiveStream !== undefined) config.enableLiveStream = elementData.enableLiveStream
    if (elementData.offImageSrc !== undefined) config.offImageSrc = elementData.offImageSrc
    if (elementData.offType !== undefined) config.offType = elementData.offType
    if (elementData.playlist !== undefined) config.playlist = elementData.playlist
    if (elementData.volume !== undefined) config.volume = elementData.volume / 100
    if (elementData.emission !== undefined) config.emission = elementData.emission
    if (elementData.enabled !== undefined) config.enabled = elementData.enabled
    if (elementData.name !== undefined) config.name = elementData.name

    // Update storage
    const key = config.customId || config.sk
    this.storage.videos.configs[key] = { ...this.storage.videos.configs[key], ...elementData }

    // Re-apply to all instances
    for (const instance of this.instances.values()) {
      if (instance.configSk === elementData.sk) {
        if (config.enabled) {
          this.applyMediaState(instance.entity, config)
        }
      }
    }
  }

  update(elementId: string, property: string, value: unknown): void {
    const data: any = { sk: elementId, [property]: value }
    this.updateElement(data)
  }

  updateInstanceData(instanceData: any): void {
    const instance = this.instances.get(instanceData.sk)
    if (!instance) return

    if (instanceData.position || instanceData.rotation || instanceData.scale) {
      const position = instanceData.position || instance.position
      const rotation = instanceData.rotation || instance.rotation
      const scale = instanceData.scale || instance.scale

      this.adapter.setTransform(instance.entity, { position, rotation, scale })
      instance.position = position
      instance.rotation = rotation
      instance.scale = scale
    }

    if (instanceData.enabled !== undefined) {
      instance.enabled = instanceData.enabled
    }

    if (instanceData.withCollisions !== undefined) {
      instance.withCollisions = instanceData.withCollisions
      if (instanceData.withCollisions) {
        this.adapter.setCollider(instance.entity, { type: 'box' })
      } else {
        this.adapter.removeCollider(instance.entity)
      }
    }

    // Update storage
    const key = instance.customId || instance.sk
    this.storage.videos.instances[key] = { ...this.storage.videos.instances[key], ...instanceData }
  }

  updateInstance(instanceId: string, property: string, value: unknown): void {
    this.updateInstanceData({ sk: instanceId, [property]: value })
  }

  delete(elementId: string): void {
    // Remove config
    const config = this.configs.get(elementId)
    if (config) {
      const configKey = config.customId || config.sk
      delete this.storage.videos.configs[configKey]
    }
    this.configs.delete(elementId)

    // Destroy all instances of this element
    for (const [sk, instance] of this.instances) {
      if (instance.configSk === elementId) {
        this.adapter.destroyEntity(instance.entity)
        const instKey = instance.customId || instance.sk
        delete this.storage.videos.instances[instKey]
        this.instances.delete(sk)
      }
    }
  }

  deleteInstance(instanceId: string): void {
    const instance = this.instances.get(instanceId)
    if (instance) {
      this.adapter.destroyEntity(instance.entity)
      const key = instance.customId || instance.sk
      delete this.storage.videos.instances[key]
      this.instances.delete(instanceId)
    }
  }

  clear(): void {
    for (const instance of this.instances.values()) {
      this.adapter.destroyEntity(instance.entity)
    }
    this.configs.clear()
    this.instances.clear()
    this.storage.videos.configs = {}
    this.storage.videos.instances = {}
  }
}
