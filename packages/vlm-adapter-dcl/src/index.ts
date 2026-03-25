import { VLM } from 'vlm-core'
import { DclAdapter } from './DclAdapter'
import { DclHUDRenderer } from './DclHUDRenderer.js'
import type { VLMInitConfig, VLMStorage } from 'vlm-shared'

/**
 * Create a VLM instance for Decentraland SDK 7.
 * Call this from your scene's index.ts.
 *
 * Automatically initializes the in-world management HUD.
 */
export async function createVLM(config?: Partial<VLMInitConfig> & { enableHud?: boolean }): Promise<VLM> {
  const adapter = new DclAdapter()
  const vlm = new VLM(adapter)
  await vlm.init({ env: 'prod', ...config })

  // Initialize the HUD unless explicitly disabled
  if (config?.enableHud !== false) {
    try {
      const renderer = new DclHUDRenderer()
      renderer.init()
      await vlm.initHUD(renderer)
      console.log('[VLM] HUD initialized')
    } catch (err) {
      console.warn('[VLM] HUD initialization failed:', err)
    }
  }

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
export { DclHUDRenderer } from './DclHUDRenderer.js'
export type { VLMInitConfig }
