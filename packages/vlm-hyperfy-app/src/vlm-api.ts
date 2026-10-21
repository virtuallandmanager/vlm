import type { Vec3 } from 'vlm-shared'
import type { ScriptFetch } from './poller.js'

export type ApiFailure = 'lost' | 'no_access' | 'auth' | 'invalid' | 'server'
export type ApiResult<T> = { ok: true; value: T } | { ok: false; reason: ApiFailure }

/** A transform in VLM coordinates (Decentraland frame, rotation in degrees): no conversion happens here. */
export interface VlmTransform {
  position: Vec3
  rotation: Vec3
  scale: Vec3
}

/** One entry of the scene library (GET /api/scenes/:id/library). */
export interface LibraryEntry {
  id: string
  kind: 'media' | 'model'
  name: string
  url: string
  status: string
  [key: string]: unknown
}

/** One catalog model (GET /api/assets); cdnUrl is the model file. */
export interface CatalogEntry {
  id: string
  name: string
  cdnUrl?: string | null
  [key: string]: unknown
}

export interface VlmApiOptions {
  feedUrl: string
  fetch: ScriptFetch
  getPass: () => string | null
  /** Called on every 401 (and when there is no pass): the owner should renew the pass. */
  onAuthFailure: () => void
}

const CATALOG_PAGE = 24

/** The model's display name: the file name in its URL, without the extension. */
function modelName(src: string): string {
  const file = src.split('?')[0].split('/').pop() || 'Model'
  let name = file
  try {
    name = decodeURIComponent(file)
  } catch {
    /* keep the raw name */
  }
  return name.replace(/\.glb$/i, '').trim().slice(0, 100) || 'Model'
}

/**
 * The Hyperfy HUD's edit client: VLM's REST API with a scene pass. Every call resolves (never rejects) with
 * ok/value or a reason. An undefined fetch (network or CORS failure) is 'lost'; 401 is 'auth' and calls
 * onAuthFailure; 403 is 'no_access'; other 4xx are 'invalid'; 5xx are 'server'.
 */
export class VlmApi {
  constructor(private readonly opts: VlmApiOptions) {}

  /** PUT /api/instances/:id */
  saveTransform(instanceId: string, t: VlmTransform): Promise<ApiResult<unknown>> {
    return this.call('PUT', `/api/instances/${encodeURIComponent(instanceId)}`, { position: t.position, rotation: t.rotation, scale: t.scale })
  }

  /** PUT /api/elements/:id { enabled } */
  setEnabled(elementId: string, enabled: boolean): Promise<ApiResult<unknown>> {
    return this.call('PUT', `/api/elements/${encodeURIComponent(elementId)}`, { enabled })
  }

  /** PUT /api/scenes/:id { activePresetId } */
  setPreset(sceneId: string, presetId: string): Promise<ApiResult<unknown>> {
    return this.call('PUT', `/api/scenes/${encodeURIComponent(sceneId)}`, { activePresetId: presetId })
  }

  /** POST /api/elements/:id/live { enabled } */
  setLive(elementId: string, enabled: boolean): Promise<ApiResult<unknown>> {
    return this.call('POST', `/api/elements/${encodeURIComponent(elementId)}/live`, { enabled })
  }

  /** GET /api/scenes/:id/library */
  async listLibrary(sceneId: string): Promise<ApiResult<LibraryEntry[]>> {
    const r = await this.call<{ items?: LibraryEntry[] }>('GET', `/api/scenes/${encodeURIComponent(sceneId)}/library`)
    return r.ok ? { ok: true, value: r.value.items ?? [] } : r
  }

  /** GET /api/assets?q=&limit= (public catalog; an empty query browses) */
  async listCatalog(query: string): Promise<ApiResult<{ assets: CatalogEntry[]; total: number }>> {
    const q = query.trim()
    const r = await this.call<{ assets?: CatalogEntry[]; total?: number }>('GET', `/api/assets?${q ? `q=${encodeURIComponent(q)}&` : ''}limit=${CATALOG_PAGE}`)
    return r.ok ? { ok: true, value: { assets: r.value.assets ?? [], total: r.value.total ?? 0 } } : r
  }

  /** POST /api/scenes/:id/library { assetItemId } */
  addFromCatalog(sceneId: string, item: { id: string }): Promise<ApiResult<unknown>> {
    return this.call('POST', `/api/scenes/${encodeURIComponent(sceneId)}/library`, { assetItemId: item.id })
  }

  /**
   * Places a model in a preset the way the dashboard does: POST /api/presets/:id/elements { type: 'model',
   * properties.modelSrc }, then POST /api/elements/:id/instances with the transform. If the instance can't be
   * made the new element is deleted again (DELETE /api/elements/:id) so no empty model is left behind.
   */
  async placeModel(presetId: string, src: string, t: VlmTransform): Promise<ApiResult<{ elementId: string; instanceId: string }>> {
    const el = await this.call<{ element?: { id?: string } }>('POST', `/api/presets/${encodeURIComponent(presetId)}/elements`, {
      type: 'model',
      name: modelName(src),
      properties: { modelSrc: src },
    })
    if (!el.ok) return el
    const elementId = el.value.element?.id
    if (!elementId) return { ok: false, reason: 'server' }
    const inst = await this.call<{ instance?: { id?: string } }>('POST', `/api/elements/${encodeURIComponent(elementId)}/instances`, {
      position: t.position,
      rotation: t.rotation,
      scale: t.scale,
    })
    const instanceId = inst.ok ? inst.value.instance?.id : undefined
    if (!inst.ok || !instanceId) {
      await this.call('DELETE', `/api/elements/${encodeURIComponent(elementId)}`)
      return inst.ok ? { ok: false, reason: 'server' } : inst
    }
    return { ok: true, value: { elementId, instanceId } }
  }

  private async call<T = unknown>(method: string, path: string, body?: object): Promise<ApiResult<T>> {
    const pass = this.opts.getPass()
    if (!pass) {
      this.opts.onAuthFailure()
      return { ok: false, reason: 'auth' }
    }
    const headers: Record<string, string> = { Authorization: `Bearer ${pass}` }
    const init: { method: string; headers: Record<string, string>; body?: string } = { method, headers }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(body)
    }
    let res: Awaited<ReturnType<ScriptFetch>>
    try {
      res = await this.opts.fetch(`${this.opts.feedUrl}${path}`, init)
    } catch {
      res = undefined
    }
    if (!res) return { ok: false, reason: 'lost' }
    if (res.status === 401) {
      this.opts.onAuthFailure()
      return { ok: false, reason: 'auth' }
    }
    if (res.status === 403) return { ok: false, reason: 'no_access' }
    if (res.status >= 500) return { ok: false, reason: 'server' }
    if (!res.ok) return { ok: false, reason: 'invalid' }
    try {
      return { ok: true, value: (await res.json()) as T }
    } catch {
      return { ok: false, reason: 'server' }
    }
  }
}
