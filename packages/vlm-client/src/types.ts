export interface AuthResponse {
  accessToken: string
  refreshToken: string
  user: { id: string; email?: string; displayName?: string; role: string }
}

export interface MediaAsset {
  id: string
  url: string
  contentType: string
  sizeBytes: number
}
