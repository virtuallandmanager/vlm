import type { Scene, AuthProof, VLMPlatformAdapter, AnalyticsSceneRef } from 'vlm-shared'
import type { AuthResponse, MediaAsset } from './types.js'
import { VLMAuth } from './auth.js'

export type SetupStatus =
  | { state: 'eligible' }
  | { state: 'member'; sceneId: string; role: 'host' | 'cohost' | 'editor' | 'viewer' }
  | { state: 'taken'; host: string }
  | { state: 'none' }
  | { state: 'unavailable' }

export interface SceneRoleEntry {
  wallet: string
  role: 'cohost' | 'editor' | 'viewer'
  userId: string | null
  displayName?: string | null
  createdAt?: string
}

/** One file in the signed-in user's Media library (`GET /api/media`). */
export interface MediaLibraryAsset {
  id: string
  filename: string
  contentType: string
  publicUrl: string | null
  sizeBytes: number
}

export class VLMHttpClient {
  private baseUrl: string
  public auth: VLMAuth

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl
    this.auth = new VLMAuth()
  }

  private async _fetch<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.auth.getAuthHeader(),
      ...(options.headers as Record<string, string> || {}),
    }
    const res = await fetch(url, { ...options, headers })
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`HTTP ${res.status}: ${body}`)
    }
    if (res.status === 204) return undefined as T
    return res.json() as Promise<T>
  }

  // Auth
  async register(email: string, password: string, displayName: string): Promise<AuthResponse> {
    const data = await this._fetch<AuthResponse>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, displayName }),
    })
    this.auth.setTokens(data.accessToken, data.refreshToken)
    return data
  }

  async login(email: string, password: string): Promise<AuthResponse> {
    const data = await this._fetch<AuthResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    })
    this.auth.setTokens(data.accessToken, data.refreshToken)
    return data
  }

  async refreshToken(): Promise<{ accessToken: string }> {
    if (!this.auth.refreshToken) throw new Error('No refresh token')
    const data = await this._fetch<{ accessToken: string }>('/api/auth/refresh', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.auth.refreshToken}` },
    })
    this.auth.token = data.accessToken
    return data
  }

  /**
   * Authenticate with the VLM server using platform credentials.
   *
   * If the adapter supports signedRequest (e.g., DCL's signedFetch), the request
   * is made through the adapter so cryptographic auth headers are included.
   * The server then verifies the AuthChain to prove the wallet identity.
   *
   * Falls back to regular fetch with proof in body for other platforms.
   */
  async authenticateWithPlatform(
    proof: AuthProof,
    platformData: Record<string, unknown>,
    adapter?: VLMPlatformAdapter,
  ): Promise<AuthResponse> {
    const path = '/api/auth/platform'
    const body = JSON.stringify({ ...platformData })

    // If the adapter can make signed requests, use that path
    // This sends the DCL AuthChain headers which the server verifies
    if (adapter?.signedRequest) {
      try {
        const response = await adapter.signedRequest(`${this.baseUrl}${path}`, {
          method: 'POST',
          body,
        })

        if (response.status < 200 || response.status >= 300) {
          throw new Error(`HTTP ${response.status}: ${response.body}`)
        }

        const data = JSON.parse(response.body) as AuthResponse
        this.auth.setTokens(data.accessToken, data.refreshToken)
        return data
      } catch (err) {
        // If signedRequest fails, fall through to regular fetch
        console.warn('[VLMHttpClient] signedRequest failed, falling back to regular fetch:', err)
      }
    }

    // Fallback: regular fetch with proof in body (unverified)
    const data = await this._fetch<AuthResponse>(path, {
      method: 'POST',
      body: JSON.stringify({ proof, ...platformData }),
    })
    this.auth.setTokens(data.accessToken, data.refreshToken)
    return data
  }

  // Scenes
  /**
   * Ask whether the signed-in wallet may set up this location, without creating an account.
   * Any failure counts as "not eligible, not known".
   */
  /** `unavailable`: Decentraland could not answer; worth retrying (unlike a plain "not eligible"). */
  async checkAnalyticsClaimSigned(
    locationKey: string,
    adapter: VLMPlatformAdapter,
  ): Promise<{ eligible: boolean; known: boolean; unavailable?: boolean }> {
    if (!adapter.signedRequest) return { eligible: false, known: false }
    try {
      const res = await adapter.signedRequest(`${this.baseUrl}/api/analytics/claims/check-signed`, {
        method: 'POST',
        body: JSON.stringify({ locationKey }),
      })
      if (res.status < 200 || res.status >= 300) return { eligible: false, known: false }
      const data = JSON.parse(res.body)
      return data.unavailable
        ? { eligible: !!data.eligible, known: !!data.known, unavailable: true }
        : { eligible: !!data.eligible, known: !!data.known }
    } catch {
      return { eligible: false, known: false }
    }
  }

  /** What the in-world HUD should offer this signed-in wallet at this location. Failures count as "none". */
  async getSetupStatus(scene: AnalyticsSceneRef, adapter: VLMPlatformAdapter): Promise<SetupStatus> {
    if (!adapter.signedRequest) return { state: 'none' }
    try {
      const res = await adapter.signedRequest(`${this.baseUrl}/api/setup/status`, { method: 'POST', body: JSON.stringify({ scene }) })
      if (res.status < 200 || res.status >= 300) return { state: 'none' }
      return JSON.parse(res.body) as SetupStatus
    } catch {
      return { state: 'none' }
    }
  }

  /** One-press setup: the signed-in wallet becomes host of a new VLM scene for this location. */
  async setUpHere(scene: AnalyticsSceneRef, adapter: VLMPlatformAdapter): Promise<{ sceneId: string } | { error: string; host?: string; status: number }> {
    if (!adapter.signedRequest) return { error: 'signed_request_unavailable', status: 0 }
    try {
      const res = await adapter.signedRequest(`${this.baseUrl}/api/setup`, { method: 'POST', body: JSON.stringify({ scene }) })
      const data = res.body ? JSON.parse(res.body) : {}
      if (res.status >= 200 && res.status < 300) return { sceneId: data.sceneId }
      return { error: data.error || 'setup_failed', host: data.host, status: res.status }
    } catch (err) {
      return { error: String(err), status: 0 }
    }
  }

  async getSceneRoles(sceneId: string): Promise<{ host: { userId: string; displayName: string | null; wallets: string[] }; roles: SceneRoleEntry[] }> {
    return this._fetch(`/api/scenes/${sceneId}/roles`)
  }

  async addSceneRole(sceneId: string, wallet: string, role: 'cohost' | 'editor' | 'viewer'): Promise<{ role: SceneRoleEntry }> {
    return this._fetch(`/api/scenes/${sceneId}/roles`, { method: 'POST', body: JSON.stringify({ wallet, role }) })
  }

  async removeSceneRole(sceneId: string, wallet: string): Promise<void> {
    await this._fetch(`/api/scenes/${sceneId}/roles/${wallet}`, { method: 'DELETE' })
  }

  async transferHost(sceneId: string, wallet: string): Promise<{ host: string }> {
    return this._fetch(`/api/scenes/${sceneId}/transfer-host`, { method: 'POST', body: JSON.stringify({ wallet }) })
  }

  async getScenes(): Promise<{ scenes: Scene[] }> {
    return this._fetch('/api/scenes')
  }

  async getScene(sceneId: string): Promise<{ scene: Scene }> {
    return this._fetch(`/api/scenes/${sceneId}`)
  }

  async createScene(name: string, description?: string): Promise<{ scene: Scene; preset: any }> {
    return this._fetch('/api/scenes', {
      method: 'POST',
      body: JSON.stringify({ name, description }),
    })
  }

  // Media library
  async getMedia(): Promise<{ assets: MediaLibraryAsset[] }> {
    return this._fetch('/api/media')
  }

  // Elements
  async createElement(presetId: string, data: Record<string, unknown>): Promise<{ element: any }> {
    return this._fetch(`/api/presets/${presetId}/elements`, {
      method: 'POST',
      body: JSON.stringify(data),
    })
  }

  async updateElement(elementId: string, data: Record<string, unknown>): Promise<{ element: any }> {
    return this._fetch(`/api/elements/${elementId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    })
  }

  async deleteElement(elementId: string): Promise<void> {
    await this._fetch(`/api/elements/${elementId}`, { method: 'DELETE' })
  }

  // Instances
  async createInstance(elementId: string, data: Record<string, unknown>): Promise<{ instance: any }> {
    return this._fetch(`/api/elements/${elementId}/instances`, {
      method: 'POST',
      body: JSON.stringify(data),
    })
  }

  async updateInstance(instanceId: string, data: Record<string, unknown>): Promise<{ instance: any }> {
    return this._fetch(`/api/instances/${instanceId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    })
  }
}
