type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

export function createApiClient(opts: { apiUrl: string; webhookKey: string; fetch?: FetchFn; timeoutMs?: number }) {
  const base = opts.apiUrl.replace(/\/+$/, '')
  const fetchFn: FetchFn = opts.fetch ?? ((u, i) => globalThis.fetch(u, i))
  const timeoutMs = opts.timeoutMs ?? 5000
  const headers = { 'Content-Type': 'application/json', ...(opts.webhookKey ? { 'X-Webhook-Key': opts.webhookKey } : {}) }
  const call = (path: string, init: RequestInit = {}) =>
    fetchFn(`${base}${path}`, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) })

  return {
    /** True only for 200 { ok: true }. Throws on timeout/network errors (callers treat that as "no"). */
    async authorize(streamKey: string): Promise<boolean> {
      const res = await call('/api/streaming/authorize', { method: 'POST', body: JSON.stringify({ streamKey }) })
      if (res.status !== 200) return false
      const body = (await res.json().catch(() => null)) as { ok?: unknown } | null
      return body?.ok === true
    },
    async notify(streamKey: string, status: 'live' | 'offline'): Promise<void> {
      try {
        const res = await call('/api/streaming/webhook', { method: 'POST', body: JSON.stringify({ streamKey, status, timestamp: Date.now() }) })
        if (!res.ok) console.error(`[webhook] VLM API returned ${res.status}`)
      } catch (err) {
        console.error('[webhook] Failed to notify VLM API:', err)
      }
    },
    async liveKeys(): Promise<string[]> {
      const res = await call('/api/streaming/live-keys')
      if (!res.ok) throw new Error(`live-keys HTTP ${res.status}`)
      const body = (await res.json()) as { streamKeys?: unknown }
      return Array.isArray(body.streamKeys) ? body.streamKeys.filter((k): k is string => typeof k === 'string') : []
    },
  }
}
