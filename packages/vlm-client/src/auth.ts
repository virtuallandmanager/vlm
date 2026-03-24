export class VLMAuth {
  token: string | null = null
  refreshToken: string | null = null

  setTokens(access: string, refresh: string): void {
    this.token = access
    this.refreshToken = refresh
  }

  getAuthHeader(): Record<string, string> {
    if (!this.token) return {}
    return { Authorization: `Bearer ${this.token}` }
  }

  isExpired(): boolean {
    if (!this.token) return true
    try {
      const payload = JSON.parse(atob(this.token.split('.')[1]))
      // Expired if less than 30 seconds remaining
      return payload.exp * 1000 < Date.now() + 30000
    } catch {
      return true
    }
  }

  clear(): void {
    this.token = null
    this.refreshToken = null
  }
}
