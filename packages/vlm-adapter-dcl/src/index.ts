import { VLM, resolveApiUrl } from 'vlm-core'
import { VLMHttpClient } from 'vlm-client'
import type { SetupStatus, MediaLibraryAsset } from 'vlm-client'
import type { VLMConnectionState } from 'vlm-core'
import { engine, Transform } from '@dcl/sdk/ecs'
import { DclAdapter } from './DclAdapter'
import { startVLMAnalytics, getAnalyticsSceneRef } from './analytics.js'
import { DclHUDRenderer, setSceneActionHandler } from './DclHUDRenderer.js'
import type { HUDMediaItem, HUDLayoutItem } from './DclHUDRenderer.js'
import type { VLMInitConfig, VLMStorage } from 'vlm-shared'

// Setup-status re-checks while Decentraland's directory is unavailable (~2.5 min).
const OWNER_CHECK_BACKOFF_MS = [10_000, 20_000, 40_000, 80_000]

// Same wording as the dashboard's Roles tab (apps/web SceneRoles.tsx).
const ROLE_ERRORS: Record<string, string> = {
  Forbidden: 'Only the host and co-hosts can manage roles.',
  is_host: 'That wallet is the host.',
  not_a_signed_in_cohost: 'They need to sign in to VLM with that wallet before they can become host.',
  host_has_no_wallet: 'Link your wallet in Settings before transferring host.',
}

/** Map a vlm-client error (`HTTP 409: {"error":"is_host"}`) to text for the Roles panel. */
function friendlyRoleError(err: unknown): string {
  const m = /^HTTP \d+: ([\s\S]*)$/.exec(err instanceof Error ? err.message : String(err))
  if (m) {
    try {
      const code = (JSON.parse(m[1]) as { error?: unknown })?.error
      if (typeof code === 'string' && ROLE_ERRORS[code]) return ROLE_ERRORS[code]
    } catch {
      // not JSON
    }
  }
  return 'Something went wrong — try again'
}

/** Map a vlm-client error from a media / layout edit to text for the Assets and Layout panels. */
function friendlyEditError(err: unknown): string {
  const status = Number(/^HTTP (\d+):/.exec(err instanceof Error ? err.message : String(err))?.[1])
  if (status === 401 || status === 403) return "You don't have permission to edit this scene"
  if (status === 404) return 'That item no longer exists — reopen the panel to refresh'
  return 'Something went wrong — try again'
}

const PLACEABLE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const LAYOUT_TYPES = new Set(['image', 'video', 'model', 'sound'])

/** Images (rendered live) and GLBs (rendered after `npx vlm-dcl sync` + redeploy) can be placed from the HUD. */
function mediaKind(a: MediaLibraryAsset): 'image' | 'model' | null {
  if (!a.publicUrl) return null
  if (PLACEABLE_IMAGE_TYPES.has(a.contentType)) return 'image'
  if (a.contentType === 'model/gltf-binary' || /\.glb$/i.test(a.filename)) return 'model'
  return null
}

const toLayoutItem = (el: any): HUDLayoutItem => ({ id: el.id, name: el.name, type: el.type, enabled: el.enabled !== false })

/**
 * Where a placed item goes: 2 m in front of the player on the XZ plane, turned to face them.
 * SDK7 Transforms of root scene entities and of the player are both relative to the scene's base
 * parcel (the analytics probe relies on the same), so this is already the scene-local space that
 * VLM instance positions use (the adapter's setTransform applies them as-is).
 */
function placementInFrontOfPlayer(kind: 'image' | 'model') {
  const t = Transform.getOrNull(engine.PlayerEntity)
  const p = t?.position ?? { x: 8, y: 0.9, z: 8 }
  const q = t?.rotation ?? { x: 0, y: 0, z: 0, w: 1 }
  const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x))
  const yawDeg = (yaw * 180) / Math.PI
  const round = (n: number) => Math.round(n * 100) / 100
  // The player's Transform is about 0.9 m above their feet
  const feet = Math.max(0, p.y - 0.9)
  return {
    position: {
      x: round(p.x + Math.sin(yaw) * 2),
      y: round(kind === 'image' ? feet + 1.2 : feet),
      z: round(p.z + Math.cos(yaw) * 2),
    },
    rotation: { x: 0, y: round((((yawDeg + 180) % 360) + 360) % 360), z: 0 },
    scale: kind === 'image' ? { x: 2, y: 2, z: 1 } : { x: 1, y: 1, z: 1 },
  }
}

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
      // Models not deployed with the scene yet; always the latest count (an upsert can emit 0 then 1)
      r.setMissingModels(vlm.missingModels())
      vlm.onModelsMissing((n) => r.setMissingModels(n))
      renderer = r
    } catch (err) {
      console.warn('[VLM] HUD initialization failed:', err)
    }
    return renderer
  }

  // initHUD runs once per vlm, after the first successful connect (which may be a Retry)
  // (shared promise, so a Retry racing an in-flight connect can't initialise it twice)
  let hudInit: Promise<void> | null = null
  const ensureHUD = async () => {
    if (!renderer) return
    if (!hudInit) {
      hudInit = vlm.initHUD(renderer).catch((err) => {
        hudInit = null
        throw err
      })
    }
    await hudInit
  }

  // If sceneId is provided, do the full init in one shot
  if (config?.sceneId) {
    ensureRenderer()
    try {
      await vlm.init({ env: 'prod', ...config })

      if (renderer) {
        renderer.setCurrentScene(config.sceneId, 'Scene')
        await ensureHUD()
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
  // createVLM never blocks the creator's scene code: it resolves right after the first status probe,
  // and connecting, setup and directory retries all continue in the background.
  type SceneRole = 'host' | 'cohost' | 'editor' | 'viewer'
  try {
    const sceneRef = await getAnalyticsSceneRef()
    const user = await adapter.getPlatformUser()
    if (user.isGuest) return vlm
    const probe = new VLMHttpClient(resolveApiUrl(config ?? {}))

    const reconnect = async (sceneId: string) => {
      try {
        renderer?.updateConnectionState('connecting', { sceneId })
        await vlm.connectToScene(sceneId)
        // A failed first connect never reached initHUD; do it now so the HUD isn't left dead after Retry
        await ensureHUD()
      } catch (err) {
        renderer?.updateConnectionState('error', { error: String(err) })
      }
    }

    // Scene actions once connected: 'retry' for everyone; roles management for host and co-hosts;
    // placing media and showing / hiding / deleting elements for host, co-hosts and editors
    // (the server enforces the same; the scene room's upsert/delete broadcast renders the result)
    const installConnectedHandler = (sceneId: string, role: SceneRole) => {
      let currentRole: SceneRole = role
      const managesRoles = () => currentRole === 'host' || currentRole === 'cohost'
      const edits = () => currentRole !== 'viewer'
      let busy = false
      let media: MediaLibraryAsset[] = []
      let layout: HUDLayoutItem[] = []

      const refresh = async () => {
        try {
          const data = await vlm.httpClient.getSceneRoles(sceneId)
          renderer?.setRoles({ hostWallets: data.host.wallets, roles: data.roles })
          renderer?.setRolesError(null)
        } catch (err) {
          renderer?.setRolesError(friendlyRoleError(err))
        }
      }
      const refreshMedia = async () => {
        const { assets } = await vlm.httpClient.getMedia()
        media = assets
        renderer?.setMedia(
          assets.flatMap((a): HUDMediaItem[] => {
            const kind = mediaKind(a)
            return kind ? [{ id: a.id, name: a.filename, kind }] : []
          }),
        )
      }
      const activePreset = async () => {
        const { scene } = await vlm.httpClient.getScene(sceneId)
        return scene.presets?.find((p) => p.id === scene.activePresetId) ?? null
      }
      const refreshLayout = async () => {
        const preset = await activePreset()
        layout = (preset?.elements ?? []).filter((el: any) => LAYOUT_TYPES.has(el.type)).map(toLayoutItem)
        renderer?.setLayout(layout)
      }
      const place = async (assetId: string) => {
        let asset = media.find((a) => a.id === assetId)
        if (!asset) {
          await refreshMedia()
          asset = media.find((a) => a.id === assetId)
        }
        const kind = asset ? mediaKind(asset) : null
        if (!asset || !kind) {
          renderer?.setEditMessage('That file is no longer in your media library', true)
          return
        }
        const scene = (await vlm.httpClient.getScene(sceneId)).scene
        if (!scene.activePresetId) {
          renderer?.setEditMessage('This scene has no active preset — pick one on the dashboard', true)
          return
        }
        const where = placementInFrontOfPlayer(kind)
        const { element } = await vlm.httpClient.createElement(scene.activePresetId, {
          type: kind,
          name: asset.filename,
          enabled: true,
          properties: kind === 'image' ? { textureSrc: asset.publicUrl } : { modelSrc: asset.publicUrl },
        })
        await vlm.httpClient.createInstance(element.id, { ...where, enabled: true })
        layout = [...layout.filter((el) => el.id !== element.id), toLayoutItem(element)]
        renderer?.setLayout(layout)
        renderer?.setEditMessage(
          kind === 'image'
            ? `Placed ${asset.filename}`
            : `Placed ${asset.filename} — run npx vlm-dcl sync and redeploy to see it`,
        )
      }

      setSceneActionHandler(async (action: string, data?: any) => {
        if (action === 'retry') return reconnect(sceneId)

        if (action.startsWith('roles_')) {
          if (!managesRoles() || busy) return
          busy = true
          try {
            if (action === 'roles_refresh') await refresh()
            if (action === 'roles_add') {
              await vlm.httpClient.addSceneRole(sceneId, data.wallet, data.role)
              renderer?.clearRoleDraft()
              await refresh()
            }
            if (action === 'roles_remove') { await vlm.httpClient.removeSceneRole(sceneId, data.wallet); await refresh() }
            if (action === 'roles_transfer' && currentRole === 'host') {
              await vlm.httpClient.transferHost(sceneId, data.wallet)
              currentRole = 'cohost'
              renderer?.setSceneRole('cohost')
              await refresh()
            }
          } catch (err) {
            renderer?.setRolesError(friendlyRoleError(err))
          } finally {
            busy = false
          }
          return
        }

        // Read-only lists: everyone sees the layout; the media library is only fetched for editors.
        // Refreshes don't take the busy lock, so opening a panel mid-edit still loads it.
        if (action === 'layout_refresh' || action === 'media_refresh') {
          if (action === 'media_refresh' && !edits()) return
          try {
            if (action === 'layout_refresh') await refreshLayout()
            else await refreshMedia()
          } catch (err) {
            renderer?.setEditMessage(friendlyEditError(err), true)
          }
          return
        }

        if (action !== 'media_place' && action !== 'layout_toggle' && action !== 'layout_delete') return
        if (!edits()) {
          renderer?.setEditMessage("You don't have permission to edit this scene", true)
          return
        }
        if (busy) return
        busy = true
        renderer?.setEditMessage(null)
        try {
          if (action === 'media_place') await place(String(data?.assetId))
          if (action === 'layout_toggle') {
            const { element } = await vlm.httpClient.updateElement(String(data?.elementId), { enabled: !!data?.enabled })
            layout = layout.map((el) => (el.id === element.id ? toLayoutItem(element) : el))
            renderer?.setLayout(layout)
          }
          if (action === 'layout_delete') {
            const id = String(data?.elementId)
            await vlm.httpClient.deleteElement(id)
            layout = layout.filter((el) => el.id !== id)
            renderer?.setLayout(layout)
          }
        } catch (err) {
          renderer?.setEditMessage(friendlyEditError(err), true)
        } finally {
          busy = false
        }
      })
      if (managesRoles()) void refresh()
    }

    const connectAs = async (sceneId: string, role: SceneRole): Promise<void> => {
      await vlm.authenticate({ env: 'prod', ...config })
      ensureRenderer()
      renderer?.setSceneRole(role)
      renderer?.updateConnectionState('connecting', { sceneId })
      renderer?.setCurrentScene(sceneId, sceneRef.title || 'Scene')
      // Installed before connecting so the error screen's Retry works even if this first connect fails
      if (renderer) installConnectedHandler(sceneId, role)
      await vlm.connectToScene(sceneId)
      await ensureHUD()
      console.log('[VLM] Connected to scene as', role, sceneId)
    }

    const connectInBackground = (sceneId: string, role: SceneRole) => {
      void connectAs(sceneId, role).catch((err) => {
        if (renderer) renderer.updateConnectionState('error', { error: String(err) })
        else console.log('[VLM] Setup unavailable:', String(err))
      })
    }

    const offerSetup = () => {
      ensureRenderer()
      if (!renderer) return
      renderer.showSetupOffer()
      let busy = false
      // Set once the server has created the setup, so a failed connect retries the connect, not the setup
      let createdSceneId: string | null = null
      const onSetupAction = async (action: string) => {
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
          await connectAs(createdSceneId, 'host')
        } catch (err) {
          // connectAs may already have swapped in the connected handler; the card needs setup_here back
          setSceneActionHandler(onSetupAction)
          renderer?.showSetupOffer(
            createdSceneId
              ? `VLM is set up, but connecting failed (${String(err)}) — press again to retry`
              : 'Setup failed — try again',
          )
        } finally {
          busy = false
        }
      }
      setSceneActionHandler(onSetupAction)
    }

    // Act on a status answer; true when it was final (no directory retry needed)
    const act = (status: SetupStatus): boolean => {
      if (status.state === 'member') connectInBackground(status.sceneId, status.role)
      else if (status.state === 'eligible') offerSetup()
      else if (status.state === 'unavailable') return false
      else if (status.state === 'taken') console.log(`[VLM] Analytics running; VLM here is already set up by ${status.host}`)
      else console.log("[VLM] Analytics running; VLM setup is only offered to this land's owners, operators and deployer")
      return true
    }

    if (!act(await probe.getSetupStatus(sceneRef, adapter))) {
      console.log("[VLM] Analytics running; Decentraland's servers aren't answering, will re-check VLM setup in the background")
      void (async () => {
        for (const delay of OWNER_CHECK_BACKOFF_MS) {
          await new Promise((r) => setTimeout(r, delay))
          if (act(await probe.getSetupStatus(sceneRef, adapter))) return
        }
        console.log('[VLM] VLM setup check gave up; Decentraland is still unavailable')
      })().catch((err) => console.log('[VLM] Setup unavailable:', String(err)))
    }
    return vlm
  } catch (err) {
    console.log('[VLM] Setup unavailable:', String(err))
    return vlm
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
