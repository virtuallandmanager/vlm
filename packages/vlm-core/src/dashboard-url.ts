// Parsed by hand: the scene runtime (and vlm-core's lib set) has no global URL
export function dashboardUrlFor(apiUrl: string): string {
  const m = /^(https?:)\/\/([^/:?#@]+)(?::(\d+))?(?:[/?#]|$)/i.exec(String(apiUrl).trim())
  if (!m) return 'https://vlm.gg'
  const protocol = m[1].toLowerCase()
  const hostname = m[2].toLowerCase()
  const isDefaultPort = (protocol === 'https:' && m[3] === '443') || (protocol === 'http:' && m[3] === '80')
  const port = m[3] && !isDefaultPort ? `:${m[3]}` : ''
  if (hostname === 'localhost' || hostname === '127.0.0.1') return 'http://localhost:3000'
  if (hostname.startsWith('api.')) return `${protocol}//${hostname.slice(4)}${port}`
  if (hostname.includes('-api.')) return `${protocol}//${hostname.replace('-api.', '.')}${port}`
  return `${protocol}//${hostname}${port}`
}

export function analyticsUrlFor(apiUrl: string, sceneId: string): string {
  return `${dashboardUrlFor(apiUrl)}/analytics/?scene=${encodeURIComponent(sceneId)}`
}

export function handoffUrlFor(apiUrl: string, code: string, next: string): string {
  return `${dashboardUrlFor(apiUrl)}/auth/handoff/?code=${encodeURIComponent(code)}&next=${encodeURIComponent(next)}`
}
