import type { Scene, AuthProof } from 'vlm-shared'
import type { AuthResponse, MediaAsset } from './types'
import { VLMAuth } from './auth'

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

  async authenticateWithPlatform(proof: AuthProof, platformData: Record<string, unknown>): Promise<AuthResponse> {
    const data = await this._fetch<AuthResponse>('/api/auth/platform', {
      method: 'POST',
      body: JSON.stringify({ proof, ...platformData }),
    })
    this.auth.setTokens(data.accessToken, data.refreshToken)
    return data
  }

  // Scenes
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
