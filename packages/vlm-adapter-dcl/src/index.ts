import { VLM } from 'vlm-core'
import type { VLMConnectionState } from 'vlm-core'
import { DclAdapter } from './DclAdapter'
import { DclHUDRenderer, setSceneActionHandler } from './DclHUDRenderer.js'
import type { VLMInitConfig, VLMStorage } from 'vlm-shared'

/**
 * Create a VLM instance for Decentraland SDK 7.
 *
 * This handles the full lifecycle:
 * 1. Shows HUD immediately (setup/connecting state)
 * 2. Authenticates with VLM using DCL's Web3 auth
 * 3. Discovers or creates a scene if no sceneId provided
 * 4. Connects to the scene via Colyseus
 * 5. HUD transitions to management mode
 *
 * If sceneId is provided, skips scene discovery and connects directly.
 * If no sceneId, authenticates first, then shows scene picker or auto-creates.
 */
export async function createVLM(config?: Partial<VLMInitConfig> & { enableHud?: boolean }): Promise<VLM> {
  const adapter = new DclAdapter()
  const vlm = new VLM(adapter)
  const enableHud = config?.enableHud !== false

  // Initialize HUD immediately so user sees something right away
  let renderer: DclHUDRenderer | null = null
  if (enableHud) {
    try {
      renderer = new DclHUDRenderer()
      renderer.init()
      renderer.updateConnectionState('idle')
    } catch (err) {
      console.warn('[VLM] HUD initialization failed:', err)
    }
  }

  // Listen to VLM state changes and forward to HUD
  if (renderer) {
    vlm.onStateChange((state: VLMConnectionState, detail?: Record<string, unknown>) => {
      renderer!.updateConnectionState(state, detail)
    })
  }

  // If sceneId is provided, do the full init in one shot
  if (config?.sceneId) {
    try {
      await vlm.init({ env: 'prod', ...config })

      if (renderer) {
        renderer.setCurrentScene(config.sceneId, 'Scene')
        await vlm.initHUD(renderer)
      }

      console.log('[VLM] Connected to scene:', config.sceneId)
      return vlm
    } catch (err) {
      if (renderer) {
        renderer.updateConnectionState('error', { error: String(err) })
      }
      throw err
    }
  }

  // No sceneId — do the two-phase flow
  try {
    // Phase 1: Authenticate
    await vlm.authenticate({ env: 'prod', ...config })

    if (renderer) {
      renderer.updateConnectionState('authenticated', {
        user: vlm.user,
      })
    }

    // Phase 2: Discover scenes
    const { scenes } = await vlm.httpClient.getScenes()

    if (renderer) {
      renderer.setScenes(scenes)
    }

    if (scenes.length === 0) {
      // Auto-create a scene for first-time users
      const sceneName = `${vlm.user?.displayName || 'My'}'s Scene`

      if (renderer) {
        renderer.updateConnectionState('connecting')
      }

      await vlm.createScene(sceneName)

      if (renderer) {
        renderer.setCurrentScene(vlm.sceneId!, sceneName)
        await vlm.initHUD(renderer)
      }

      console.log('[VLM] Auto-created and connected to scene:', vlm.sceneId)
      return vlm
    }

    if (scenes.length === 1) {
      // Single scene — connect directly
      const scene = scenes[0]

      if (renderer) {
        renderer.setCurrentScene(scene.id, scene.name)
      }

      await vlm.connectToScene(scene.id)

      if (renderer) {
        await vlm.initHUD(renderer)
      }

      console.log('[VLM] Connected to scene:', scene.name)
      return vlm
    }

    // Multiple scenes — show picker in HUD and wait for selection
    if (renderer) {
      renderer.updateConnectionState('authenticated', {
        user: vlm.user,
        scenes,
      })
    }

    return new Promise<VLM>((resolve, reject) => {
      // Set up handler for scene actions from the HUD
      setSceneActionHandler(async (action: string, data?: any) => {
        try {
          if (action === 'select_scene') {
            const sceneId = data?.sceneId
            const scene = scenes.find(s => s.id === sceneId)

            if (renderer) {
              renderer.updateConnectionState('connecting', { sceneId })
              renderer.setCurrentScene(sceneId, scene?.name || 'Scene')
            }

            await vlm.connectToScene(sceneId)

            if (renderer) {
              await vlm.initHUD(renderer)
            }

            console.log('[VLM] Connected to scene:', scene?.name || sceneId)
            resolve(vlm)
          } else if (action === 'create_scene') {
            const name = data?.name || `${vlm.user?.displayName || 'My'}'s Scene`

            if (renderer) {
              renderer.updateConnectionState('connecting')
            }

            await vlm.createScene(name)

            if (renderer) {
              renderer.setCurrentScene(vlm.sceneId!, name)
              await vlm.initHUD(renderer)
            }

            console.log('[VLM] Created and connected to scene:', name)
            resolve(vlm)
          } else if (action === 'retry') {
            // Retry the whole flow
            try {
              const retried = await createVLM(config)
              resolve(retried)
            } catch (err) {
              reject(err)
            }
          }
        } catch (err) {
          if (renderer) {
            renderer.updateConnectionState('error', { error: String(err) })
          }
          // Don't reject — let user retry via HUD
        }
      })
    })
  } catch (err) {
    if (renderer) {
      renderer.updateConnectionState('error', { error: String(err) })
    }

    // Set up retry handler
    return new Promise<VLM>((resolve, reject) => {
      setSceneActionHandler(async (action: string) => {
        if (action === 'retry') {
          try {
            const retried = await createVLM(config)
            resolve(retried)
          } catch (retryErr) {
            reject(retryErr)
          }
        }
      })
    })
  }
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
