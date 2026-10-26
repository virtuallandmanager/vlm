export interface AuthResponse {
  accessToken: string
  refreshToken: string | null
  user: { id: string; email?: string; displayName?: string; role: string }
  /** Present for in-world sign-ins: the scene (and location) the server bound this scene pass to. */
  scene?: { sceneId: string | null; locationId: string | null }
}

export interface MediaAsset {
  id: string
  url: string
  contentType: string
  sizeBytes: number
}
