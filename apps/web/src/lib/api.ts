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

    // Billing
    getBillingUsage: () => apiFetch<{ tier: string; limits: any; usage: any }>('/api/billing/usage'),
    getBillingSubscription: () => apiFetch<{ tier: string; status: string; billingEnabled?: boolean; limits: any }>('/api/billing/subscription'),
    createCheckout: (priceId: string) => apiFetch<{ url: string }>('/api/billing/checkout', { method: 'POST', body: JSON.stringify({ priceId }) }),
    getPortalUrl: () => apiFetch<{ url: string }>('/api/billing/portal', { method: 'POST', body: JSON.stringify({}) }),

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
  }
}
