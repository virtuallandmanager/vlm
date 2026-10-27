// Parsed by hand: the scene runtime (and @virvixr/core's lib set) has no global URL

/** The website origin for an API URL, or null when it can't be derived (userinfo, IPv6, garbage). */
export function dashboardOriginFor(apiUrl: string): string | null {
  const m = /^(https?:)\/\/([^/:?#@[\]]+)(?::(\d+))?(?:[/?#]|$)/i.exec(String(apiUrl).trim())
  if (!m) return null
  const protocol = m[1].toLowerCase()
  const hostname = m[2].toLowerCase()
  const isDefaultPort = (protocol === 'https:' && m[3] === '443') || (protocol === 'http:' && m[3] === '80')
  const port = m[3] && !isDefaultPort ? `:${m[3]}` : ''
  if (hostname === 'localhost' || hostname === '127.0.0.1') return 'http://localhost:3000'
  if (hostname.startsWith('api.')) return `${protocol}//${hostname.slice(4)}${port}`
  if (hostname.includes('-api.')) return `${protocol}//${hostname.replace('-api.', '.')}${port}`
  return `${protocol}//${hostname}${port}`
}

export function dashboardUrlFor(apiUrl: string): string {
  return dashboardOriginFor(apiUrl) ?? 'https://virvi.io'
}

export function analyticsUrlFor(apiUrl: string, sceneId: string): string {
  return `${dashboardUrlFor(apiUrl)}/analytics/?scene=${encodeURIComponent(sceneId)}`
}

/**
 * The hand-off page link. The code rides in the fragment, which browsers never send to a server, log or put in a Referer.
 * Null when the dashboard origin can't be derived from the API URL: a code is never sent to the virvi.io fallback.
 */
export function handoffUrlFor(apiUrl: string, code: string, next: string): string | null {
  const origin = dashboardOriginFor(apiUrl)
  if (!origin) return null
  return `${origin}/auth/handoff/#code=${encodeURIComponent(code)}&next=${encodeURIComponent(next)}`
}
