import type { VirviStorage } from '@virvixr/shared'

export class VirviStorageImpl {
  static create(): VirviStorage {
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
