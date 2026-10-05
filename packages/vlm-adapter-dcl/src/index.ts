import { VLM, resolveApiUrl } from 'vlm-core'
import { VLMHttpClient } from 'vlm-client'
import type { VLMConnectionState } from 'vlm-core'
import { DclAdapter } from './DclAdapter'
import { startVLMAnalytics, getAnalyticsSceneRef } from './analytics.js'
import { DclHUDRenderer, setSceneActionHandler } from './DclHUDRenderer.js'
import type { VLMInitConfig, VLMStorage } from 'vlm-shared'

// Setup-status re-checks while Decentraland's directory is unavailable (~2.5 min).
const OWNER_CHECK_BACKOFF_MS = [10_000, 20_000, 40_000, 80_000]

/**
 * Create a VLM instance for Decentraland SDK 7.
 *
 * If sceneId is provided, authenticates and connects to that scene directly.
 * If not, asks the VLM server what the signed-in wallet gets at this location:
 * - a member of this location's setup (host / co-host / editor / viewer) connects straight to its scene;
 * - an owner, operator or deployer of the land with no setup yet gets a one-press "Set up VLM here" card;
 * - everyone else (visitors, guests, wallets without a role) gets no VLM UI at all.
 */
export async function createVLM(config?: Partial<VLMInitConfig> & { enableHud?: boolean }): Promise<VLM> {
  const adapter = new DclAdapter()
  const vlm = new VLM(adapter)
  if (config?.analytics !== false) {
    // Analytics start once per scene runtime; every createVLM call (retries included) attaches the shared collector.
    void startVLMAnalytics({ env: config?.env, apiUrl: config?.apiUrl, adapter }).then((c) => {
      if (c) vlm.attachAnalytics(c)
    })
  }
  const enableHud = config?.enableHud !== false

  // The HUD is created lazily: visitors never get one (see the eligibility check below)
  let renderer = null as DclHUDRenderer | null
  const ensureRenderer = (): DclHUDRenderer | null => {
    if (renderer || !enableHud) return renderer
    try {
      const r = new DclHUDRenderer()
      r.init()
      r.updateConnectionState('idle')
      vlm.onStateChange((state: VLMConnectionState, detail?: Record<string, unknown>) => {
        r.updateConnectionState(state, detail)
      })
      renderer = r
    } catch (err) {
      console.warn('[VLM] HUD initialization failed:', err)
    }
    return renderer
  }

  // If sceneId is provided, do the full init in one shot
  if (config?.sceneId) {
    ensureRenderer()
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

  // No sceneId: ask the server what this wallet gets here (nothing / Set up / member of the setup).
  // Visitors, role-less wallets and wallets that can't set up here never get any VLM UI.
  type SceneRole = 'host' | 'cohost' | 'editor' | 'viewer'
  try {
    const sceneRef = await getAnalyticsSceneRef()
    const user = await adapter.getPlatformUser()
    if (user.isGuest) return vlm
    const probe = new VLMHttpClient(resolveApiUrl(config ?? {}))

    const installRolesHandler = (sceneId: string, role: SceneRole) => {
      if (role !== 'host' && role !== 'cohost') return
      let currentRole: SceneRole = role
      const refresh = async () => {
        try {
          const data = await vlm.httpClient.getSceneRoles(sceneId)
          renderer?.setRoles({ hostWallets: data.host.wallets, roles: data.roles })
          renderer?.setRolesError(null)
        } catch (err) {
          renderer?.setRolesError(String(err))
        }
      }
      setSceneActionHandler(async (action: string, data?: any) => {
        try {
          if (action === 'roles_refresh') await refresh()
          if (action === 'roles_add') { await vlm.httpClient.addSceneRole(sceneId, data.wallet, data.role); await refresh() }
          if (action === 'roles_remove') { await vlm.httpClient.removeSceneRole(sceneId, data.wallet); await refresh() }
          if (action === 'roles_transfer' && currentRole === 'host') {
            await vlm.httpClient.transferHost(sceneId, data.wallet)
            currentRole = 'cohost'
            renderer?.setSceneRole('cohost')
            await refresh()
          }
        } catch (err) {
          renderer?.setRolesError(String(err))
        }
      })
      void refresh()
    }

    const connectAs = async (sceneId: string, role: SceneRole): Promise<VLM> => {
      await vlm.authenticate({ env: 'prod', ...config })
      ensureRenderer()
      renderer?.setSceneRole(role)
      renderer?.updateConnectionState('connecting', { sceneId })
      renderer?.setCurrentScene(sceneId, sceneRef.title || 'Scene')
      await vlm.connectToScene(sceneId)
      if (renderer) {
        await vlm.initHUD(renderer)
        installRolesHandler(sceneId, role)
      }
      console.log('[VLM] Connected to scene as', role, sceneId)
      return vlm
    }

    let status = await probe.getSetupStatus(sceneRef, adapter)
    for (const delay of OWNER_CHECK_BACKOFF_MS) {
      if (status.state !== 'unavailable') break
      await new Promise((r) => setTimeout(r, delay))
      status = await probe.getSetupStatus(sceneRef, adapter)
    }
    if (status.state === 'member') return await connectAs(status.sceneId, status.role)
    if (status.state !== 'eligible') {
      console.log("[VLM] Analytics running; VLM setup is only offered to this land's owners, operators and deployer")
      return vlm
    }

    ensureRenderer()
    if (!renderer) return vlm
    renderer.showSetupOffer()
    return await new Promise<VLM>((resolve) => {
      let busy = false
      // Set once the server has created the setup, so a failed connect retries the connect, not the setup
      let createdSceneId: string | null = null
      setSceneActionHandler(async (action: string) => {
        if (action !== 'setup_here' || busy) return
        busy = true
        try {
          renderer?.updateConnectionState('connecting')
          if (!createdSceneId) {
            const res = await probe.setUpHere(sceneRef, adapter)
            if (!('sceneId' in res)) {
              const msg =
                res.error === 'already_set_up' ? `Already set up by ${res.host ?? 'someone else'}`
                : res.status === 503 ? "Decentraland's servers aren't answering — try again in a minute"
                : res.status === 403 ? "Only this land's owner, operators or deployer can set up VLM here"
                : `Setup failed (${res.error})`
              renderer?.showSetupOffer(msg)
              return
            }
            createdSceneId = res.sceneId
          }
          resolve(await connectAs(createdSceneId, 'host'))
        } catch (err) {
          renderer?.showSetupOffer(`VLM is set up, but connecting failed (${String(err)}) — press again to retry`)
        } finally {
          busy = false
        }
      })
    })
  } catch (err) {
    if (renderer) {
      renderer.updateConnectionState('error', { error: String(err) })
    } else {
      console.log('[VLM] Setup unavailable:', String(err))
      return vlm
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
export { startVLMAnalytics, stopVLMAnalytics, DclAnalyticsProbe, getAnalyticsSceneRef } from './analytics.js'
