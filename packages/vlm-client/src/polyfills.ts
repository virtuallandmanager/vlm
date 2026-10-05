/**
 * Minimal network polyfills for sandboxed runtimes (notably Decentraland's scene runtime),
 * which provide `fetch` and `WebSocket` but neither `URL` nor `XMLHttpRequest`.
 * colyseus.js needs both: `new URL()` in its Client constructor, and XMLHttpRequest (via httpie)
 * for matchmaking. Installed only when missing; native implementations are left alone.
 */

type AnyGlobal = Record<string, any>

class MinimalURL {
  href: string
  protocol: string
  hostname: string
  port: string
  pathname: string
  search: string
  host: string
  origin: string

  constructor(url: string, base?: string) {
    if (base && url.startsWith('/')) url = base.replace(/\/$/, '') + url
    this.href = url
    const m = url.match(/^(https?|wss?):\/\/([^/:?#]+)(:(\d+))?([^?#]*)(\?[^#]*)?/)
    this.protocol = m ? m[1] + ':' : 'https:'
    this.hostname = m ? m[2] : 'localhost'
    this.port = m ? m[4] || '' : ''
    this.pathname = m ? m[5] || '/' : url
    this.search = m ? m[6] || '' : ''
    this.host = this.hostname + (this.port ? ':' + this.port : '')
    this.origin = this.protocol + '//' + this.host
  }

  toString(): string {
    return this.href
  }
}

/** Just enough of XMLHttpRequest for httpie's xhr transport, backed by fetch. */
class FetchXMLHttpRequest {
  status = 0
  statusText = ''
  response: string | null = null
  responseText = ''
  timeout = 0
  withCredentials = false
  onload: (() => void) | null = null
  onerror: ((e: { type: string; message?: string }) => void) | null = null
  ontimeout: ((e: { type: string }) => void) | null = null
  private method = 'GET'
  private url = ''
  private headers: Record<string, string> = {}
  private responseHeaders = ''

  open(method: string, url: string): void {
    this.method = method
    this.url = url
  }

  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value
  }

  getAllResponseHeaders(): string {
    return this.responseHeaders
  }

  send(body?: string | null): void {
    const doFetch = (globalThis as AnyGlobal).fetch as (url: string, init: unknown) => Promise<any>
    doFetch(this.url, { method: this.method, headers: this.headers, body: body ?? undefined })
      .then(async (res: any) => {
        this.status = res.status
        this.statusText = res.statusText || ''
        const lines: string[] = []
        res.headers?.forEach?.((value: string, key: string) => lines.push(`${key}: ${value}`))
        this.responseHeaders = lines.join('\r\n')
        this.responseText = await res.text()
        this.response = this.responseText
        this.onload?.()
      })
      .catch((err: unknown) => this.onerror?.({ type: 'error', message: String(err) }))
  }
}

export function ensureNetworkPolyfills(): void {
  const g = globalThis as AnyGlobal
  if (typeof g.URL === 'undefined') g.URL = MinimalURL
  if (typeof g.XMLHttpRequest === 'undefined' && typeof g.fetch === 'function') g.XMLHttpRequest = FetchXMLHttpRequest
}
