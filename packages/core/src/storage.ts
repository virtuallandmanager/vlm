import type { VLMStorage } from '@virvixr/shared'

export class VLMStorageImpl {
  static create(): VLMStorage {
    return {
      videos: { configs: {}, instances: {} },
      images: { configs: {}, instances: {} },
      models: { configs: {}, instances: {}, missing: new Set<string>() },
      sounds: { configs: {}, instances: {} },
      nfts: { configs: {}, instances: {} },
      claimPoints: { configs: {}, instances: {} },
      widgets: { configs: {}, instances: {} },
      adSpaces: { configs: {}, instances: {} },
    }
  }
}
