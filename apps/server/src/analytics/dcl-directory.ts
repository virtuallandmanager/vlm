import { config } from '../config.js'

export interface ActiveScene {
  entityId: string
  base: string
  parcels: string[]
  title?: string
}

export interface ParcelRights {
  owner: string | null
  operator: string | null
  updateOperator: string | null
  updateManagers: string[]
  approvedForAll: string[]
}

export interface DclDirectory {
  getActiveSceneAt(parcel: string): Promise<ActiveScene | null>
  getActiveDeployer(parcel: string): Promise<string | null>
  getWorldScene(name: string): Promise<{ sceneUrns: string[]; title?: string } | null>
  getParcelRights(parcel: string): Promise<ParcelRights | null>
  getWorldOwner(name: string): Promise<string | null>
  getWorldDeployers(name: string): Promise<string[]>
}

export class DirectoryUnavailableError extends Error {}

const TIMEOUT_MS = 3_000
const lower = (v: unknown) => (typeof v === 'string' && v ? v.toLowerCase() : null)
const lowerList = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').map((x: string) => x.toLowerCase()) : [])

async function getJson(url: string, init?: RequestInit): Promise<unknown | null> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
    // Only 404/400 mean "not found"; every other non-2xx is an upstream problem, not an answer.
    if (res.status === 404 || res.status === 400) return null
    if (!res.ok) throw new DirectoryUnavailableError(`${url}: HTTP ${res.status}`)
    return await res.json()
  } catch (err) {
    if (err instanceof DirectoryUnavailableError) throw err
    throw new DirectoryUnavailableError(`${url}: ${(err as Error).message}`)
  }
}

export class HttpDclDirectory implements DclDirectory {
  constructor(private catalyst = config.catalystUrl, private worlds = config.worldsUrl) {}

  async getActiveSceneAt(parcel: string): Promise<ActiveScene | null> {
    const body = (await getJson(`${this.catalyst}/content/entities/active`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pointers: [parcel] }),
    })) as Array<{ id: string; metadata?: { scene?: { base?: string; parcels?: string[] }; display?: { title?: string } } }> | null
    const e = body?.[0]
    if (!e?.metadata?.scene?.base) return null
    return { entityId: e.id, base: e.metadata.scene.base, parcels: e.metadata.scene.parcels ?? [], title: e.metadata.display?.title }
  }

  async getActiveDeployer(parcel: string): Promise<string | null> {
    const q = new URLSearchParams({ pointer: parcel, onlyCurrentlyPointed: 'true', limit: '1' })
    const body = (await getJson(`${this.catalyst}/content/deployments?${q}`)) as { deployments?: Array<{ deployedBy?: string }> } | null
    return lower(body?.deployments?.[0]?.deployedBy)
  }

  async getWorldScene(name: string) {
    const body = (await getJson(`${this.worlds}/world/${encodeURIComponent(name.toLowerCase())}/about`)) as {
      configurations?: { scenesUrn?: string[] }
    } | null
    const urns = body?.configurations?.scenesUrn ?? []
    return urns.length ? { sceneUrns: urns } : null
  }

  async getParcelRights(parcel: string): Promise<ParcelRights | null> {
    const [x, y] = parcel.split(',')
    const body = (await getJson(`${this.catalyst}/lambdas/parcels/${x}/${y}/operators`)) as Record<string, unknown> | null
    if (!body) return null
    return {
      owner: lower(body.owner),
      operator: lower(body.operator),
      updateOperator: lower(body.updateOperator),
      updateManagers: lowerList(body.updateManagers),
      approvedForAll: lowerList(body.approvedForAll),
    }
  }

  async getWorldOwner(name: string): Promise<string | null> {
    const body = (await getJson(`${this.worlds}/world/${encodeURIComponent(name.toLowerCase())}/permissions`)) as { owner?: string } | null
    return lower(body?.owner)
  }

  async getWorldDeployers(name: string): Promise<string[]> {
    const body = (await getJson(`${this.worlds}/world/${encodeURIComponent(name.toLowerCase())}/permissions`)) as
      | { permissions?: { deployment?: { type?: string; wallets?: unknown } } }
      | null
    const d = body?.permissions?.deployment
    return d?.type === 'allow-list' ? lowerList(d.wallets) : []
  }
}

let current: DclDirectory | null = null

export function getDclDirectory(): DclDirectory {
  if (!current) current = new HttpDclDirectory()
  return current
}

/** Tests inject a fake; pass null to restore the HTTP implementation. */
export function setDclDirectory(d: DclDirectory | null): void {
  current = d
}
