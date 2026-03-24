import { VLM } from 'vlm-core'
import { DclAdapter } from './DclAdapter'
import type { VLMInitConfig, VLMStorage } from 'vlm-shared'

/**
 * Create a VLM instance for Decentraland SDK 7.
 * Call this from your scene's index.ts.
 */
export async function createVLM(config?: Partial<VLMInitConfig>): Promise<VLM> {
  const adapter = new DclAdapter()
  const vlm = new VLM(adapter)
  await vlm.init({ env: 'prod', ...config })
  return vlm
}

// Backward-compatible default export
const VLMCompat = {
  init: async (config?: Partial<VLMInitConfig>): Promise<VLMStorage> => {
    const vlm = await createVLM(config)
    return vlm.storage
  },
}
export default VLMCompat

export { DclAdapter }
export type { VLMInitConfig }
