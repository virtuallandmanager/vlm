export class FlyError extends Error {
  status: number
  body: string
  constructor(message: string, status: number, body: string) {
    super(message)
    this.name = 'FlyError'
    this.status = status
    this.body = body
  }
}

export type WorldMachineSpec = { image: string; env: Record<string, string> }

type FlyOpts = { token: string; org: string; fetch?: typeof fetch; baseUrl?: string; timeoutMs?: number }

const REGION = 'iad'
const REQUEST_TIMEOUT_MS = 30_000

function machineBody(m: WorldMachineSpec) {
  return {
    region: REGION,
    config: {
      image: m.image,
      env: m.env,
      guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 1024 },
      services: [{
        protocol: 'tcp',
        internal_port: 3000,
        autostop: 'stop',
        autostart: true,
        min_machines_running: 0,
        ports: [{ port: 80, handlers: ['http'] }, { port: 443, handlers: ['tls', 'http'] }],
      }],
    },
  }
}

export class FlyApi {
  private token: string
  private org: string
  private fetchFn: typeof fetch
  private baseUrl: string
  private timeoutMs: number

  constructor(opts: FlyOpts) {
    this.token = opts.token
    this.org = opts.org
    this.fetchFn = opts.fetch ?? fetch
    this.baseUrl = (opts.baseUrl ?? 'https://api.machines.dev/v1').replace(/\/+$/, '')
    this.timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS
  }

  private scrub(s: string): string {
    return this.token ? s.split(this.token).join('[redacted]') : s
  }

  private async request(method: string, path: string, body?: unknown, okStatuses: number[] = []): Promise<{ status: number; text: string }> {
    let res: Response
    try {
      res = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (e) {
      if ((e as Error)?.name === 'TimeoutError') {
        throw new FlyError(`Fly ${method} ${path} timed out after ${this.timeoutMs / 1000} s`, 0, '')
      }
      const msg = this.scrub(e instanceof Error ? e.message : String(e))
      throw new FlyError(`Fly ${method} ${path} failed: ${msg}`, 0, '')
    }
    const text = this.scrub(await res.text().catch(() => ''))
    if (res.ok || okStatuses.includes(res.status)) return { status: res.status, text }
    let detail = text.slice(0, 500)
    try {
      const j = JSON.parse(text)
      if (typeof j?.error === 'string') detail = j.error
    } catch { /* non-JSON body */ }
    throw new FlyError(`Fly ${method} ${path} returned ${res.status}: ${detail}`, res.status, text)
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const { status, text } = await this.request(method, path, body)
    try {
      return JSON.parse(text) as T
    } catch {
      throw new FlyError(`Fly ${method} ${path} returned ${status} with a body that is not JSON`, status, text.slice(0, 500))
    }
  }

  async createApp(name: string): Promise<void> {
    await this.request('POST', '/apps', { app_name: name, org_slug: this.org })
  }

  async deleteApp(name: string): Promise<void> {
    await this.request('DELETE', `/apps/${encodeURIComponent(name)}`, undefined, [404])
  }

  async allocatePublicIps(app: string): Promise<void> {
    for (const type of ['shared_v4', 'v6']) {
      await this.request('POST', `/apps/${encodeURIComponent(app)}/ip_assignments`, { type })
    }
  }

  /** One private IPv6 (Flycast) address, which the worlds router proxies large requests to. */
  async allocatePrivateIp(app: string): Promise<void> {
    await this.request('POST', `/apps/${encodeURIComponent(app)}/ip_assignments`, { type: 'private_v6' })
  }

  async createMachine(app: string, m: WorldMachineSpec): Promise<{ id: string }> {
    const r = await this.json<{ id: string }>('POST', `/apps/${encodeURIComponent(app)}/machines`, machineBody(m))
    return { id: r.id }
  }

  async updateMachine(app: string, id: string, m: WorldMachineSpec): Promise<void> {
    await this.request('POST', `/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(id)}`, machineBody(m))
  }

  async listMachines(app: string): Promise<{ id: string; state: string }[]> {
    const r = await this.json<{ id: string; state: string }[]>('GET', `/apps/${encodeURIComponent(app)}/machines`)
    return r.map((x) => ({ id: x.id, state: x.state }))
  }

  async getMachineEnv(app: string, id: string): Promise<Record<string, string>> {
    const r = await this.json<{ config?: { env?: Record<string, string> } }>('GET', `/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(id)}`)
    return r.config?.env ?? {}
  }

  async stopMachine(app: string, id: string): Promise<void> {
    await this.request('POST', `/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(id)}/stop`)
  }

  async startMachine(app: string, id: string): Promise<void> {
    await this.request('POST', `/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(id)}/start`)
  }
}
