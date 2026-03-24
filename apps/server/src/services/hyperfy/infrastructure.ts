/**
 * Infrastructure Provider — Pluggable backend for provisioning Hyperfy worlds.
 *
 * Each provider manages the lifecycle of Hyperfy containers/processes:
 * create, destroy, get status, get logs.
 *
 * Providers:
 *   - FlyProvider   — Fly.io Machines API (production)
 *   - DockerProvider — Local Docker API (self-hosted scalable)
 *   - LocalProvider  — Spawn child process (development/single mode)
 */

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface InstanceConfig {
  /** Unique name/slug for this world */
  name: string
  /** Region for deployment (provider-specific) */
  region?: string
  /** Environment variables to set on the instance */
  env: Record<string, string>
  /** Docker image to use (provider may have a default) */
  image?: string
}

export interface InstanceInfo {
  /** Provider-specific instance ID (Fly machine ID, Docker container ID, PID) */
  instanceId: string
  /** Public URL of the running Hyperfy world */
  url: string
  /** WebSocket URL for agent connections */
  wsUrl: string
  /** Current status */
  status: 'starting' | 'running' | 'stopped' | 'failed'
  /** Provider name */
  provider: string
}

export interface InfrastructureProvider {
  readonly name: string

  /** Create and start a new Hyperfy instance. */
  createInstance(config: InstanceConfig): Promise<InstanceInfo>

  /** Destroy/remove an instance. */
  destroyInstance(instanceId: string): Promise<void>

  /** Get current status of an instance. */
  getStatus(instanceId: string): Promise<InstanceInfo | null>

  /** Get recent logs from an instance. */
  getLogs(instanceId: string, lines?: number): Promise<string>
}

// ---------------------------------------------------------------------------
// Fly.io Provider
// ---------------------------------------------------------------------------

export class FlyProvider implements InfrastructureProvider {
  readonly name = 'fly'
  private apiToken: string
  private appName: string
  private baseImage: string

  constructor(options: {
    apiToken: string
    appName?: string
    baseImage?: string
  }) {
    this.apiToken = options.apiToken
    this.appName = options.appName || 'vlm-hyperfy'
    this.baseImage = options.baseImage || 'ghcr.io/hyperfy-xyz/hyperfy:latest'
  }

  async createInstance(config: InstanceConfig): Promise<InstanceInfo> {
    const machineConfig = {
      name: `vlm-${config.name}`,
      region: config.region || 'iad',
      config: {
        image: config.image || this.baseImage,
        env: config.env,
        services: [
          {
            ports: [
              { port: 443, handlers: ['tls', 'http'] },
              { port: 80, handlers: ['http'] },
            ],
            protocol: 'tcp',
            internal_port: 3000,
          },
        ],
        guest: {
          cpu_kind: 'shared',
          cpus: 1,
          memory_mb: 512,
        },
      },
    }

    const res = await fetch(
      `https://api.machines.dev/v1/apps/${this.appName}/machines`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(machineConfig),
      },
    )

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Fly.io create failed: ${res.status} ${err}`)
    }

    const machine = (await res.json()) as any
    const hostname = `${config.name}.fly.dev`

    return {
      instanceId: machine.id,
      url: `https://${hostname}`,
      wsUrl: `wss://${hostname}/ws`,
      status: 'starting',
      provider: this.name,
    }
  }

  async destroyInstance(instanceId: string): Promise<void> {
    const res = await fetch(
      `https://api.machines.dev/v1/apps/${this.appName}/machines/${instanceId}?force=true`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${this.apiToken}` },
      },
    )

    if (!res.ok && res.status !== 404) {
      throw new Error(`Fly.io destroy failed: ${res.status}`)
    }
  }

  async getStatus(instanceId: string): Promise<InstanceInfo | null> {
    const res = await fetch(
      `https://api.machines.dev/v1/apps/${this.appName}/machines/${instanceId}`,
      {
        headers: { Authorization: `Bearer ${this.apiToken}` },
      },
    )

    if (res.status === 404) return null
    if (!res.ok) throw new Error(`Fly.io status failed: ${res.status}`)

    const machine = (await res.json()) as any
    const flyState = machine.state as string

    return {
      instanceId: machine.id,
      url: `https://${machine.name?.replace('vlm-', '')}.fly.dev`,
      wsUrl: `wss://${machine.name?.replace('vlm-', '')}.fly.dev/ws`,
      status: flyState === 'started' ? 'running' : flyState === 'stopped' ? 'stopped' : 'starting',
      provider: this.name,
    }
  }

  async getLogs(instanceId: string, _lines = 100): Promise<string> {
    // Fly.io logs are accessed via the `fly logs` CLI or nats — simplified here
    return `[fly] Logs for machine ${instanceId} — use 'fly logs -a ${this.appName}' for full output`
  }
}

// ---------------------------------------------------------------------------
// Docker Provider (for self-hosted / docker-compose setups)
// ---------------------------------------------------------------------------

export class DockerProvider implements InfrastructureProvider {
  readonly name = 'docker'
  private socketPath: string
  private baseImage: string
  private network: string

  constructor(options?: {
    socketPath?: string
    baseImage?: string
    network?: string
  }) {
    this.socketPath = options?.socketPath || '/var/run/docker.sock'
    this.baseImage = options?.baseImage || 'ghcr.io/hyperfy-xyz/hyperfy:latest'
    this.network = options?.network || 'vlm-network'
  }

  async createInstance(config: InstanceConfig): Promise<InstanceInfo> {
    const containerName = `vlm-hyperfy-${config.name}`
    const envArray = Object.entries(config.env).map(([k, v]) => `${k}=${v}`)

    // Create container via Docker Engine API
    const createRes = await fetch(`http://localhost/containers/create?name=${containerName}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        Image: config.image || this.baseImage,
        Env: envArray,
        ExposedPorts: { '3000/tcp': {} },
        HostConfig: {
          NetworkMode: this.network,
          RestartPolicy: { Name: 'unless-stopped' },
        },
      }),
      // @ts-ignore — Node fetch supports unix sockets via custom agent
      socketPath: this.socketPath,
    } as any)

    if (!createRes.ok) {
      throw new Error(`Docker create failed: ${createRes.status} ${await createRes.text()}`)
    }

    const container = (await createRes.json()) as any

    // Start the container
    await fetch(`http://localhost/containers/${container.Id}/start`, {
      method: 'POST',
      // @ts-ignore
      socketPath: this.socketPath,
    } as any)

    return {
      instanceId: container.Id,
      url: `http://${containerName}:3000`,
      wsUrl: `ws://${containerName}:3000/ws`,
      status: 'starting',
      provider: this.name,
    }
  }

  async destroyInstance(instanceId: string): Promise<void> {
    // Stop + remove
    await fetch(`http://localhost/containers/${instanceId}/stop`, {
      method: 'POST',
      // @ts-ignore
      socketPath: this.socketPath,
    } as any).catch(() => {})

    await fetch(`http://localhost/containers/${instanceId}?force=true`, {
      method: 'DELETE',
      // @ts-ignore
      socketPath: this.socketPath,
    } as any)
  }

  async getStatus(instanceId: string): Promise<InstanceInfo | null> {
    const res = await fetch(`http://localhost/containers/${instanceId}/json`, {
      // @ts-ignore
      socketPath: this.socketPath,
    } as any)

    if (res.status === 404) return null
    const data = (await res.json()) as any

    return {
      instanceId,
      url: `http://${data.Name?.replace('/', '')}:3000`,
      wsUrl: `ws://${data.Name?.replace('/', '')}:3000/ws`,
      status: data.State?.Running ? 'running' : 'stopped',
      provider: this.name,
    }
  }

  async getLogs(instanceId: string, lines = 100): Promise<string> {
    const res = await fetch(
      `http://localhost/containers/${instanceId}/logs?stdout=true&stderr=true&tail=${lines}`,
      {
        // @ts-ignore
        socketPath: this.socketPath,
      } as any,
    )
    return res.ok ? await res.text() : ''
  }
}

// ---------------------------------------------------------------------------
// Local Process Provider (for development)
// ---------------------------------------------------------------------------

export class LocalProvider implements InfrastructureProvider {
  readonly name = 'local'
  private processes: Map<string, { pid: number; port: number }> = new Map()
  private nextPort = 4000

  async createInstance(config: InstanceConfig): Promise<InstanceInfo> {
    const port = this.nextPort++
    const instanceId = `local-${config.name}-${port}`

    // In development, we'd spawn a child process here.
    // For now, store a stub so the provisioner flow works end-to-end.
    this.processes.set(instanceId, { pid: 0, port })

    return {
      instanceId,
      url: `http://localhost:${port}`,
      wsUrl: `ws://localhost:${port}/ws`,
      status: 'running',
      provider: this.name,
    }
  }

  async destroyInstance(instanceId: string): Promise<void> {
    const proc = this.processes.get(instanceId)
    if (proc?.pid) {
      try {
        process.kill(proc.pid)
      } catch {}
    }
    this.processes.delete(instanceId)
  }

  async getStatus(instanceId: string): Promise<InstanceInfo | null> {
    const proc = this.processes.get(instanceId)
    if (!proc) return null

    return {
      instanceId,
      url: `http://localhost:${proc.port}`,
      wsUrl: `ws://localhost:${proc.port}/ws`,
      status: proc.pid ? 'running' : 'stopped',
      provider: this.name,
    }
  }

  async getLogs(_instanceId: string): Promise<string> {
    return '[local] Logs not available for local process provider'
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createInfrastructureProvider(): InfrastructureProvider {
  const provider = process.env.HYPERFY_INFRA_PROVIDER || 'local'

  switch (provider) {
    case 'fly':
      return new FlyProvider({
        apiToken: process.env.FLY_API_TOKEN!,
        appName: process.env.FLY_HYPERFY_APP,
        baseImage: process.env.HYPERFY_IMAGE,
      })
    case 'docker':
      return new DockerProvider({
        socketPath: process.env.DOCKER_SOCKET,
        baseImage: process.env.HYPERFY_IMAGE,
        network: process.env.DOCKER_NETWORK,
      })
    case 'local':
    default:
      return new LocalProvider()
  }
}
