import { AD_LIMITS } from '@virvixr/shared'
import type { AdEventBatch, AdFormats, AdItem, AdServeResponse, AdShape, EntityHandle, Quat, Vec3, VLMPlatformAdapter } from '@virvixr/shared'
import { AdRotation } from './rotation.js'
import { AdTracker } from './tracker.js'

export interface AdSpaceInfo {
  shape: AdShape
  formats: AdFormats
  shortSideM: number
  /** World position of the space's centre, for on-screen measurement. */
  position: Vec3
}

interface Attached {
  elementId: string
  entity: EntityHandle
  space: AdSpaceInfo
  rotation: AdRotation
}

export interface AdHostOptions {
  adapter: VLMPlatformAdapter
  /** The serve call (VLMHttpClient.getAds); null on any failure. */
  getAds: (elementIds: string[]) => Promise<AdServeResponse | null>
  /** The events call (VLMHttpClient.sendAdEvents); status 0 when there was no response. */
  postEvents: (batch: AdEventBatch) => Promise<{ ok: boolean; status: number }>
  now?: () => number
}

const MOVE_M = 0.05
const TURN_DEG = 2

function sessionId(): string {
  const webCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (webCrypto?.randomUUID) return webCrypto.randomUUID.call(webCrypto)
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
}

/** Items a space of these formats may show. */
function forFormats(ads: AdItem[], formats: AdFormats): AdItem[] {
  return formats === 'both' ? ads : ads.filter((a) => a.kind === formats)
}

/**
 * Serves and measures ads for every ad space and ads-mode screen in the scene: one serve refresh, one
 * frequency-cap history, one video-ad budget and one tracker for the whole scene runtime.
 */
export class AdHost {
  readonly tracker: AdTracker
  readonly now: () => number
  private readonly adapter: VLMPlatformAdapter
  private readonly getAds: AdHostOptions['getAds']
  private readonly history = new Map<string, number[]>()
  private readonly attached = new Map<string, Attached>()
  private readonly listeners = new Set<() => void>()
  private served: AdServeResponse | null = null
  /** Element ids already asked for, so a newly attached element triggers a refresh. */
  private requested = new Set<string>()
  /** The shape each element had when its ads were asked for; served ads for another shape are never shown. */
  private requestedShapes = new Map<string, AdShape>()
  private videosPlaying = 0
  private refreshing = false
  private nextRefreshAt = 0
  private system: ((dt: number) => void) | null = null
  private lastPose: { position: Vec3; rotation: Quat | null } | null = null

  constructor(opts: AdHostOptions) {
    this.adapter = opts.adapter
    this.getAds = opts.getAds
    this.now = opts.now ?? Date.now
    const id = sessionId()
    this.tracker = new AdTracker({
      now: this.now,
      onSeen: (key, adId) => this.attached.get(key)?.rotation.seen(adId),
      // A 4xx batch will never be accepted: drop it (true) so it can't block the queue; keep it on 5xx or no response.
      send: async (events) => {
        const res = await opts.postEvents({ v: 1, sessionId: id, events })
        return res.ok || (res.status >= 400 && res.status < 500)
      },
    })
  }

  /** Begin serving and measuring (after scene init): serve now, then every serveRefreshMs. */
  start(): Promise<void> {
    if (!this.system) {
      this.system = () => this.frame()
      this.adapter.registerSystem(this.system)
    }
    return this.refresh()
  }

  stop(): void {
    if (this.system) this.adapter.unregisterSystem(this.system)
    this.system = null
    void this.tracker.flush()
  }

  /** Called after each serve refresh; returns an unsubscribe. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  attach(key: string, elementId: string, entity: EntityHandle, space: AdSpaceInfo): void {
    const prev = this.attached.get(key)
    const rotation = prev?.elementId === elementId ? prev.rotation : new AdRotation([], { now: this.now, history: this.history })
    const entry = { elementId, entity, space, rotation }
    this.attached.set(key, entry)
    this.syncItems(entry)
  }

  detach(key: string): void {
    const a = this.attached.get(key)
    this.attached.delete(key)
    // Last copy of this element gone: ask again when it comes back (e.g. recreated with a new shape)
    if (a && ![...this.attached.values()].some((o) => o.elementId === a.elementId)) this.requested.delete(a.elementId)
    this.tracker.showing(key, '', null)
  }

  /** The next ad for this space, or null when it has nothing to show (failed serve, paused, too small, none eligible). */
  nextFor(key: string, allowVideo: boolean): AdItem | null {
    const a = this.attached.get(key)
    if (!a || a.space.shortSideM < AD_LIMITS.minShortSideM) return null
    const served = this.served?.spaces[a.elementId]
    if (!served || served.paused) return null
    return a.rotation.next(allowVideo)
  }

  /** Take one of the scene's video-ad slots; false when maxVideoAdsPerScene are already playing. */
  videoSlot(): boolean {
    if (this.videosPlaying >= AD_LIMITS.maxVideoAdsPerScene) return false
    this.videosPlaying++
    return true
  }

  releaseVideoSlot(): void {
    this.videosPlaying = Math.max(0, this.videosPlaying - 1)
  }

  /** Ask the server for every attached space's ads. A failure leaves every space with nothing to show until the next refresh. */
  async refresh(): Promise<void> {
    if (this.refreshing) return
    const ids = [...new Set([...this.attached.values()].map((a) => a.elementId))]
    this.nextRefreshAt = this.now() + AD_LIMITS.serveRefreshMs
    this.requested = new Set(ids)
    this.requestedShapes = new Map([...this.attached.values()].map((a) => [a.elementId, a.space.shape]))
    if (ids.length === 0) {
      this.served = null
      return
    }
    this.refreshing = true
    try {
      const res = await this.getAds(ids)
      const ok = !!res && typeof res.spaces === 'object' && res.spaces !== null
      this.served = ok ? res : null
    } catch {
      this.served = null
    } finally {
      this.refreshing = false
    }
    for (const a of this.attached.values()) this.syncItems(a)
    for (const listener of [...this.listeners]) {
      try { listener() } catch { /* swallow */ }
    }
  }

  private syncItems(a: Attached): void {
    const fits = this.requestedShapes.get(a.elementId) === a.space.shape
    a.rotation.setItems(fits ? forFormats(this.served?.spaces[a.elementId]?.ads ?? [], a.space.formats) : [])
  }

  private frame(): void {
    const t = this.now()
    const unseen = [...this.attached.values()].some((a) => !this.requested.has(a.elementId))
    if (t >= this.nextRefreshAt || unseen) void this.refresh()

    const camera = this.adapter.getCameraPose?.() ?? null
    const probe = this.adapter.analytics
    const position = probe?.getPlayerPose()?.position ?? camera?.position ?? null
    const spaces: Record<string, { position: Vec3; shortSideM: number }> = {}
    for (const [key, a] of this.attached) spaces[key] = { position: a.space.position, shortSideM: a.space.shortSideM }
    this.tracker.tick({
      inScene: position && probe ? probe.isInsideScene(position) : true,
      moved: this.moved(position, camera?.rotation ?? null),
      camera,
      spaces,
    })
  }

  /** Moved more than MOVE_M or turned the camera more than TURN_DEG since the last frame. */
  private moved(position: Vec3 | null, rotation: Quat | null): boolean {
    const last = this.lastPose
    if (position) this.lastPose = { position, rotation }
    if (!position || !last) return false
    const dx = position.x - last.position.x
    const dy = position.y - last.position.y
    const dz = position.z - last.position.z
    if (Math.sqrt(dx * dx + dy * dy + dz * dz) > MOVE_M) return true
    if (!rotation || !last.rotation) return false
    const d = Math.abs(rotation.x * last.rotation.x + rotation.y * last.rotation.y + rotation.z * last.rotation.z + rotation.w * last.rotation.w)
    const deg = (2 * Math.acos(Math.min(1, d)) * 180) / Math.PI
    return deg > TURN_DEG
  }
}
