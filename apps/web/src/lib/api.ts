'use client'
import { useCallback } from 'react'
import { useAuth } from './auth'
import { API_URL } from './config'

export function useApi() {
  const { token } = useAuth()

  const apiFetch = useCallback(async <T = any>(path: string, options: RequestInit = {}): Promise<T> => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers as Record<string, string> || {}),
    }
    const res = await fetch(`${API_URL}${path}`, { ...options, headers })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
      throw new Error(err.error || `API error ${res.status}`)
    }
    if (res.status === 204) return undefined as T
    return res.json()
  }, [token])

  return {
    // Scenes
    getScenes: () => apiFetch<{ scenes: any[] }>('/api/scenes'),
    getScene: (id: string) => apiFetch<{ scene: any }>(`/api/scenes/${id}`),
    createScene: (name: string, description?: string) =>
      apiFetch<{ scene: any; preset: any }>('/api/scenes', { method: 'POST', body: JSON.stringify({ name, description }) }),
    updateScene: (id: string, data: Record<string, any>) =>
      apiFetch<{ scene: any }>(`/api/scenes/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    deleteScene: (id: string) =>
      apiFetch(`/api/scenes/${id}`, { method: 'DELETE' }),

    // Scene Collaborators
    getSceneCollaborators: (sceneId: string) =>
      apiFetch<{ collaborators: any[] }>(`/api/scenes/${sceneId}/collaborators`),
    addSceneCollaborator: (sceneId: string, email: string, role: string) =>
      apiFetch<{ collaborator: any }>(`/api/scenes/${sceneId}/collaborators`, { method: 'POST', body: JSON.stringify({ email, role }) }),
    updateSceneCollaborator: (sceneId: string, userId: string, role: string) =>
      apiFetch<{ collaborator: any }>(`/api/scenes/${sceneId}/collaborators/${userId}`, { method: 'PUT', body: JSON.stringify({ role }) }),
    removeSceneCollaborator: (sceneId: string, userId: string) =>
      apiFetch(`/api/scenes/${sceneId}/collaborators/${userId}`, { method: 'DELETE' }),

    // Scene State
    getSceneState: (sceneId: string) =>
      apiFetch<{ state: Record<string, any> }>(`/api/scenes/${sceneId}/state`),
    setSceneState: (sceneId: string, key: string, value: any) =>
      apiFetch<{ updated: number }>(`/api/scenes/${sceneId}/state`, { method: 'PUT', body: JSON.stringify({ key, value }) }),
    deleteSceneStateKey: (sceneId: string, key: string) =>
      apiFetch(`/api/scenes/${sceneId}/state/${key}`, { method: 'DELETE' }),
    clearSceneState: (sceneId: string) =>
      apiFetch(`/api/scenes/${sceneId}/state`, { method: 'DELETE' }),

    // Elements
    createElement: (presetId: string, data: Record<string, any>) =>
      apiFetch<{ element: any }>(`/api/presets/${presetId}/elements`, { method: 'POST', body: JSON.stringify(data) }),
    updateElement: (id: string, data: Record<string, any>) =>
      apiFetch<{ element: any }>(`/api/elements/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    deleteElement: (id: string) =>
      apiFetch(`/api/elements/${id}`, { method: 'DELETE' }),

    // Instances
    createInstance: (elementId: string, data: Record<string, any>) =>
      apiFetch<{ instance: any }>(`/api/elements/${elementId}/instances`, { method: 'POST', body: JSON.stringify(data) }),
    updateInstance: (id: string, data: Record<string, any>) =>
      apiFetch<{ instance: any }>(`/api/instances/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    deleteInstance: (id: string) =>
      apiFetch(`/api/instances/${id}`, { method: 'DELETE' }),

    // Media
    getMedia: () => apiFetch<{ assets: any[] }>('/api/media'),
    uploadMedia: (filename: string, contentType: string, data: string) =>
      apiFetch<{ asset: any }>('/api/media/upload', { method: 'POST', body: JSON.stringify({ filename, contentType, data }) }),
    deleteMedia: (assetId: string) =>
      apiFetch(`/api/media/${assetId}`, { method: 'DELETE' }),

    // Organizations
    getOrgs: () => apiFetch<{ organizations: any[] }>('/api/orgs'),
    createOrg: (name: string) => apiFetch<{ organization: any }>('/api/orgs', { method: 'POST', body: JSON.stringify({ name }) }),
    getOrgMembers: (orgId: string) => apiFetch<{ members: any[] }>(`/api/orgs/${orgId}/members`),
    inviteToOrg: (orgId: string, email: string, role?: string) => apiFetch<{ invite: any }>(`/api/orgs/${orgId}/invites`, { method: 'POST', body: JSON.stringify({ email, role }) }),
    removeOrgMember: (orgId: string, userId: string) => apiFetch(`/api/orgs/${orgId}/members/${userId}`, { method: 'DELETE' }),
    setActiveOrg: (orgId: string) => apiFetch<{ activeOrgId: string }>(`/api/orgs/${orgId}/active`, { method: 'PUT' }),
    acceptInvite: (token: string) => apiFetch<{ accepted: boolean; orgId: string }>('/api/orgs/accept-invite', { method: 'POST', body: JSON.stringify({ token }) }),

    // Platform Hooks
    getHooks: () => apiFetch<{ hooks: any[] }>('/api/hooks'),
    deleteHook: (hookId: string) => apiFetch(`/api/hooks/${hookId}`, { method: 'DELETE' }),

    // API Keys
    getApiKeys: () => apiFetch<{ keys: any[] }>('/api/keys'),
    createApiKey: (name: string, scopes?: string[]) => apiFetch<{ key: string; apiKey: any }>('/api/keys', { method: 'POST', body: JSON.stringify({ name, scopes }) }),
    deleteApiKey: (keyId: string) => apiFetch(`/api/keys/${keyId}`, { method: 'DELETE' }),

    // Analytics
    getSceneAnalyticsRecent: (sceneId: string) =>
      apiFetch<{ visitors: number; actions: number; activeSessions: number; recentSessions: any[] }>(`/api/analytics/scenes/${sceneId}/recent`),
    getSceneAnalyticsSessions: (sceneId: string, params?: { limit?: number; offset?: number }) => {
      const query = new URLSearchParams()
      if (params?.limit) query.set('limit', String(params.limit))
      if (params?.offset) query.set('offset', String(params.offset))
      const qs = query.toString()
      return apiFetch<{ sessions: any[] }>(`/api/analytics/scenes/${sceneId}/sessions${qs ? `?${qs}` : ''}`)
    },

    // Giveaways
    getGiveaways: () => apiFetch<{ giveaways: any[] }>('/api/giveaways'),
    getGiveaway: (id: string) => apiFetch<{ giveaway: any }>(`/api/giveaways/${id}`),
    createGiveaway: (data: { name: string; enabled?: boolean; claimLimit?: number }) =>
      apiFetch<{ giveaway: any }>('/api/giveaways', { method: 'POST', body: JSON.stringify(data) }),
    updateGiveaway: (id: string, data: { name?: string; enabled?: boolean; claimLimit?: number }) =>
      apiFetch<{ giveaway: any }>(`/api/giveaways/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    deleteGiveaway: (id: string) =>
      apiFetch(`/api/giveaways/${id}`, { method: 'DELETE' }),
    addGiveawayItem: (giveawayId: string, data: { name?: string; imageUrl?: string; contractAddress?: string; tokenId?: string; metadata?: unknown }) =>
      apiFetch<{ item: any }>(`/api/giveaways/${giveawayId}/items`, { method: 'POST', body: JSON.stringify(data) }),
    deleteGiveawayItem: (giveawayId: string, itemId: string) =>
      apiFetch(`/api/giveaways/${giveawayId}/items/${itemId}`, { method: 'DELETE' }),
    getGiveawayClaims: (giveawayId: string) =>
      apiFetch<{ claims: any[] }>(`/api/giveaways/${giveawayId}/claims`),

    // Account
    updateProfile: (displayName: string) =>
      apiFetch<{ user: any }>('/api/auth/profile', { method: 'PUT', body: JSON.stringify({ displayName }) }),
    changePassword: (currentPassword: string, newPassword: string) =>
      apiFetch<{ success: boolean }>('/api/auth/password', { method: 'PUT', body: JSON.stringify({ currentPassword, newPassword }) }),
    deleteAccount: (password: string) =>
      apiFetch('/api/auth/account', { method: 'DELETE', body: JSON.stringify({ password }) }),

    // Admin
    getAdminStats: () => apiFetch<{
      totalUsers: number; totalOrgs: number; totalScenes: number;
      totalMedia: number; totalStorageBytes: number;
      activeSubscriptionsByTier: Record<string, number>;
    }>('/api/admin/stats'),
    getAdminUsers: (params?: { limit?: number; offset?: number; search?: string }) => {
      const query = new URLSearchParams()
      if (params?.limit) query.set('limit', String(params.limit))
      if (params?.offset) query.set('offset', String(params.offset))
      if (params?.search) query.set('search', params.search)
      const qs = query.toString()
      return apiFetch<{ users: any[]; total: number; limit: number; offset: number }>(
        `/api/admin/users${qs ? `?${qs}` : ''}`,
      )
    },
    getAdminUser: (id: string) => apiFetch<{ user: any; subscription: any }>(`/api/admin/users/${id}`),
    updateUserRole: (userId: string, role: string) =>
      apiFetch<{ user: any }>(`/api/admin/users/${userId}/role`, { method: 'PUT', body: JSON.stringify({ role }) }),
    deleteUser: (userId: string) =>
      apiFetch(`/api/admin/users/${userId}`, { method: 'DELETE' }),
    getAdminOrgs: (params?: { limit?: number; offset?: number; search?: string }) => {
      const query = new URLSearchParams()
      if (params?.limit) query.set('limit', String(params.limit))
      if (params?.offset) query.set('offset', String(params.offset))
      if (params?.search) query.set('search', params.search)
      const qs = query.toString()
      return apiFetch<{ organizations: any[]; total: number; limit: number; offset: number }>(
        `/api/admin/orgs${qs ? `?${qs}` : ''}`,
      )
    },
    deleteOrg: (orgId: string) =>
      apiFetch(`/api/admin/orgs/${orgId}`, { method: 'DELETE' }),

    // Billing
    getBillingUsage: () => apiFetch<{ tier: string; limits: any; usage: any }>('/api/billing/usage'),
    getBillingSubscription: () => apiFetch<{ tier: string; status: string; billingEnabled?: boolean; limits: any }>('/api/billing/subscription'),
    createCheckout: (priceId: string) => apiFetch<{ url: string }>('/api/billing/checkout', { method: 'POST', body: JSON.stringify({ priceId }) }),
    getPortalUrl: () => apiFetch<{ url: string }>('/api/billing/portal', { method: 'POST', body: JSON.stringify({}) }),

    // Deployments
    getDeployments: (sceneId: string) =>
      apiFetch<{ deployments: any[] }>(`/api/deploy/scene/${sceneId}`),
    getDeployment: (id: string) =>
      apiFetch<{ deployment: any }>(`/api/deploy/${id}`),
    createDeployment: (data: { sceneId: string; platform: string; deploymentType: string; target: Record<string, unknown>; walletId?: string }) =>
      apiFetch<{ deployment: any }>('/api/deploy', { method: 'POST', body: JSON.stringify(data) }),
    cancelDeployment: (id: string) =>
      apiFetch<{ deployment: any }>(`/api/deploy/${id}/cancel`, { method: 'POST' }),
    redeployDeployment: (id: string) =>
      apiFetch<{ deployment: any }>(`/api/deploy/${id}/redeploy`, { method: 'POST' }),
    getDeployWallets: () =>
      apiFetch<{ wallets: any[] }>('/api/deploy/wallets'),
    createDeployWallet: (data: { platform: string; walletAddress: string; encryptedPrivateKey?: string; label?: string }) =>
      apiFetch<{ wallet: any }>('/api/deploy/wallets', { method: 'POST', body: JSON.stringify(data) }),
    deleteDeployWallet: (id: string) =>
      apiFetch<{ deleted: boolean }>(`/api/deploy/wallets/${id}`, { method: 'DELETE' }),
    provisionHyperfy: (data: { sceneId: string; name: string; region?: string }) =>
      apiFetch<any>('/api/deploy/hyperfy/provision', { method: 'POST', body: JSON.stringify(data) }),
    destroyHyperfy: (id: string) =>
      apiFetch<{ destroyed: boolean }>(`/api/deploy/hyperfy/${id}/destroy`, { method: 'POST' }),
    getHyperfyStatus: (id: string) =>
      apiFetch<{ instance: any }>(`/api/deploy/hyperfy/${id}/status`),
    getHyperfyLogs: (id: string, lines?: number) => {
      const query = lines ? `?lines=${lines}` : ''
      return apiFetch<{ logs: string }>(`/api/deploy/hyperfy/${id}/logs${query}`)
    },

    // Streaming
    getStreamingServers: () => apiFetch<{ servers: any[] }>('/api/streaming'),
    getStreamingServer: (id: string) => apiFetch<{ server: any }>(`/api/streaming/${id}`),
    provisionStreamingServer: (data: { name: string; type?: 'shared' | 'dedicated'; region?: string; sceneId?: string }) =>
      apiFetch<{ server: any; instructions: any }>('/api/streaming/provision', { method: 'POST', body: JSON.stringify(data) }),
    deleteStreamingServer: (id: string) =>
      apiFetch<{ terminated: boolean }>(`/api/streaming/${id}`, { method: 'DELETE' }),
    getStreamingSessions: (serverId: string) =>
      apiFetch<{ sessions: any[] }>(`/api/streaming/${serverId}/sessions`),

    // 3D Asset Library
    getAssets: (params?: { q?: string; category?: string; tag?: string; maxTriangles?: string; maxFileSize?: string; limit?: string; offset?: string }) => {
      const query = new URLSearchParams()
      if (params?.q) query.set('q', params.q)
      if (params?.category) query.set('category', params.category)
      if (params?.tag) query.set('tag', params.tag)
      if (params?.maxTriangles) query.set('maxTriangles', params.maxTriangles)
      if (params?.maxFileSize) query.set('maxFileSize', params.maxFileSize)
      if (params?.limit) query.set('limit', params.limit)
      if (params?.offset) query.set('offset', params.offset)
      const qs = query.toString()
      return apiFetch<{ assets: any[]; total: number; limit: number; offset: number }>(
        `/api/assets${qs ? `?${qs}` : ''}`,
      )
    },
    getAsset: (id: string) => apiFetch<{ asset: any }>(`/api/assets/${id}`),
    getAssetCategories: () => apiFetch<{ categories: string[] }>('/api/assets/categories'),
    uploadAsset: (data: {
      name: string
      description?: string
      category?: string
      tags?: string[]
      fileData: string
      contentType: string
      filename: string
      triangleCount?: number
      textureCount?: number
      materialCount?: number
      dimensions?: { width: number; height: number; depth: number }
      license?: string
      author?: string
      isPublic?: boolean
    }) => apiFetch<{ asset: any }>('/api/assets', { method: 'POST', body: JSON.stringify(data) }),
    updateAsset: (id: string, data: Record<string, any>) =>
      apiFetch<{ asset: any }>(`/api/assets/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    deleteAsset: (id: string) =>
      apiFetch<{ deleted: boolean }>(`/api/assets/${id}`, { method: 'DELETE' }),

    // Command Center
    getCommandCenterStatus: (eventId: string) =>
      apiFetch<{ event: any; worlds: any[]; aggregate: { worldCount: number; deployedCount: number } }>(`/api/command-center/${eventId}/status`),
    broadcastToEvent: (eventId: string, data: { action: Record<string, unknown>; targetScenes?: string[] | 'all' }) =>
      apiFetch<{ dispatched: number; sceneIds: string[] }>(`/api/command-center/${eventId}/broadcast`, { method: 'POST', body: JSON.stringify(data) }),

    // Events
    getEvents: () => apiFetch<{ events: any[] }>('/api/events'),
    getEvent: (id: string) => apiFetch<{ event: any }>(`/api/events/${id}`),
    createEvent: (data: { name: string; description?: string; startTime?: string; endTime?: string; timezone?: string }) =>
      apiFetch<{ event: any }>('/api/events', { method: 'POST', body: JSON.stringify(data) }),
    updateEvent: (id: string, data: { name?: string; description?: string; startTime?: string; endTime?: string; timezone?: string }) =>
      apiFetch<{ event: any }>(`/api/events/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    deleteEvent: (id: string) =>
      apiFetch(`/api/events/${id}`, { method: 'DELETE' }),
    linkSceneToEvent: (eventId: string, sceneId: string) =>
      apiFetch<{ link: any }>(`/api/events/${eventId}/link-scene`, { method: 'POST', body: JSON.stringify({ sceneId }) }),
    unlinkSceneFromEvent: (eventId: string, sceneId: string) =>
      apiFetch(`/api/events/${eventId}/unlink-scene/${sceneId}`, { method: 'DELETE' }),
    linkGiveawayToEvent: (eventId: string, giveawayId: string) =>
      apiFetch<{ link: any }>(`/api/events/${eventId}/link-giveaway`, { method: 'POST', body: JSON.stringify({ giveawayId }) }),
    unlinkGiveawayFromEvent: (eventId: string, giveawayId: string) =>
      apiFetch(`/api/events/${eventId}/unlink-giveaway/${giveawayId}`, { method: 'DELETE' }),
  }
}
