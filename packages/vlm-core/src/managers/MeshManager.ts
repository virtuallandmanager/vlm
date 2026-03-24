import type { VLMPlatformAdapter, VLMStorage, EntityHandle } from 'vlm-shared'

// Internal tracking of element config
interface MeshConfig {
  sk: string
  name: string
  enabled: boolean
  customId?: string
  modelSrc?: string
}

// Internal tracking of element instance -> entity mapping
interface MeshInstance {
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

export class MeshManager {
  private adapter: VLMPlatformAdapter
  private storage: VLMStorage
  private configs: Map<string, MeshConfig> = new Map()
  private instances: Map<string, MeshInstance> = new Map()

  constructor(adapter: VLMPlatformAdapter, storage: VLMStorage) {
    this.adapter = adapter
    this.storage = storage
  }

  init(elements: any[]): void {
    if (!this.adapter.capabilities.gltfModels) return

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
    const config: MeshConfig = {
      sk: data.sk,
      name: data.name || '',
      enabled: data.enabled ?? true,
      customId: data.customId,
      modelSrc: data.modelSrc,
    }
    this.configs.set(config.sk, config)

    const key = config.customId || config.sk
    this.storage.models.configs[key] = data
  }

  private createInstanceEntity(configSk: string, data: any): void {
    const config = this.configs.get(configSk)
    if (!config || !config.modelSrc) return

    const entity = this.adapter.createEntity()

    const position = data.position || { x: 0, y: 0, z: 0 }
    const rotation = data.rotation || { x: 0, y: 0, z: 0 }
    const scale = data.scale || { x: 1, y: 1, z: 1 }

    this.adapter.setTransform(entity, { position, rotation, scale })
    this.adapter.setGltfModel(entity, config.modelSrc)

    // Set collider if needed
    if (data.withCollisions) {
      this.adapter.setCollider(entity, { type: 'mesh' })
    }

    const instance: MeshInstance = {
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

    const key = data.customId || data.sk
    this.storage.models.instances[key] = data
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

    if (elementData.modelSrc !== undefined) config.modelSrc = elementData.modelSrc
    if (elementData.enabled !== undefined) config.enabled = elementData.enabled
    if (elementData.name !== undefined) config.name = elementData.name

    // Update storage
    const key = config.customId || config.sk
    this.storage.models.configs[key] = { ...this.storage.models.configs[key], ...elementData }

    // If model source changed, re-apply to all instances
    if (elementData.modelSrc !== undefined && config.modelSrc) {
      for (const instance of this.instances.values()) {
        if (instance.configSk === elementData.sk) {
          this.adapter.setGltfModel(instance.entity, config.modelSrc)
        }
      }
    }
  }

  update(elementId: string, property: string, value: unknown): void {
    this.updateElement({ sk: elementId, [property]: value })
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
        this.adapter.setCollider(instance.entity, { type: 'mesh' })
      } else {
        this.adapter.removeCollider(instance.entity)
      }
    }

    // Update storage
    const key = instance.customId || instance.sk
    this.storage.models.instances[key] = { ...this.storage.models.instances[key], ...instanceData }
  }

  updateInstance(instanceId: string, property: string, value: unknown): void {
    this.updateInstanceData({ sk: instanceId, [property]: value })
  }

  delete(elementId: string): void {
    const config = this.configs.get(elementId)
    if (config) {
      const configKey = config.customId || config.sk
      delete this.storage.models.configs[configKey]
    }
    this.configs.delete(elementId)

    for (const [sk, instance] of this.instances) {
      if (instance.configSk === elementId) {
        this.adapter.destroyEntity(instance.entity)
        const instKey = instance.customId || instance.sk
        delete this.storage.models.instances[instKey]
        this.instances.delete(sk)
      }
    }
  }

  deleteInstance(instanceId: string): void {
    const instance = this.instances.get(instanceId)
    if (instance) {
      this.adapter.destroyEntity(instance.entity)
      const key = instance.customId || instance.sk
      delete this.storage.models.instances[key]
      this.instances.delete(instanceId)
    }
  }

  clear(): void {
    for (const instance of this.instances.values()) {
      this.adapter.destroyEntity(instance.entity)
    }
    this.configs.clear()
    this.instances.clear()
    this.storage.models.configs = {}
    this.storage.models.instances = {}
  }
}
