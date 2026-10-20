/** Shared vocabulary for Hyperfy worlds: the scene feed protocol and the visit analytics batch. */

export const HYPERFY_FEED = {
  version: 1,
  /** Long-poll hold, in ms. */
  holdMs: 25_000,
  /** App back-off bounds on failure, in ms. */
  retryMinMs: 1_000,
  retryMaxMs: 30_000,
  /** How often a poll updates a world's lastSeenAt, in ms. */
  lastSeenThrottleMs: 60_000,
  analyticsFlushMs: 15_000,
  positionSampleMs: 5_000,
  keyPrefix: 'vlmw_',
} as const

/** One serialized element (video, image, model, sound, ...) with its instances; other keys are allowed. */
export interface SerializedSceneElement {
  sk?: string
  instances?: unknown[]
  [key: string]: unknown
}

/** The preset JSON shape the feed serves; other keys (nfts, widgets, ...) are allowed. */
export interface SerializedScene {
  videos: SerializedSceneElement[]
  images: SerializedSceneElement[]
  models: SerializedSceneElement[]
  sounds: SerializedSceneElement[]
  [key: string]: unknown
}

export interface HyperfyFeedResponse {
  v: 1
  /** SHA-256 of the scene JSON. */
  version: string
  /** Null when the scene has no active preset. */
  scene: SerializedScene | null
}

export interface HyperfyWorldSummary {
  id: string
  sceneId: string
  name: string
  kind: 'self'
  /** First 12 characters of the world key, to tell keys apart; never the whole key. */
  keyPrefix: string
  createdAt: string
  lastSeenAt: string | null
}

export type HyperfyVisitEventType = 'enter' | 'leave' | 'pos'

export interface HyperfyVisitEvent {
  type: HyperfyVisitEventType
  playerId: string
  t: number
  x?: number
  y?: number
  z?: number
}

export interface HyperfyAnalyticsBatch {
  v: 1
  events: HyperfyVisitEvent[]
}

export type HyperfyAnalyticsCheck = { ok: true; batch: HyperfyAnalyticsBatch } | { ok: false; error: string }

export const HYPERFY_ANALYTICS_LIMITS = { maxBatchEvents: 200, maxPlayerIdLength: 100 } as const

const EVENT_TYPES: ReadonlySet<string> = new Set<HyperfyVisitEventType>(['enter', 'leave', 'pos'])

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export function checkHyperfyAnalyticsBatch(body: unknown): HyperfyAnalyticsCheck {
  if (!isObj(body)) return { ok: false, error: 'batch must be an object' }
  if (body.v !== 1) return { ok: false, error: 'v must be 1' }
  const max = HYPERFY_ANALYTICS_LIMITS.maxBatchEvents
  if (!Array.isArray(body.events) || body.events.length > max) {
    return { ok: false, error: `events must be an array of up to ${max} items` }
  }
  const events: HyperfyVisitEvent[] = []
  for (const e of body.events) {
    if (!isObj(e)) return { ok: false, error: 'event must be an object' }
    if (typeof e.type !== 'string' || !EVENT_TYPES.has(e.type)) return { ok: false, error: `unknown event type: ${String(e.type)}` }
    if (typeof e.playerId !== 'string' || e.playerId.length < 1 || e.playerId.length > HYPERFY_ANALYTICS_LIMITS.maxPlayerIdLength) {
      return { ok: false, error: `playerId must be a string of 1-${HYPERFY_ANALYTICS_LIMITS.maxPlayerIdLength} characters` }
    }
    if (!isNum(e.t)) return { ok: false, error: 'event.t must be a number' }
    const hasCoords = e.x !== undefined || e.y !== undefined || e.z !== undefined
    if (e.type === 'pos') {
      if (!isNum(e.x) || !isNum(e.y) || !isNum(e.z)) return { ok: false, error: 'pos events need numeric x, y and z' }
      events.push({ type: 'pos', playerId: e.playerId, t: e.t, x: e.x, y: e.y, z: e.z })
    } else {
      if (hasCoords) return { ok: false, error: `${e.type} events must not have coordinates` }
      events.push({ type: e.type as 'enter' | 'leave', playerId: e.playerId, t: e.t })
    }
  }
  return { ok: true, batch: { v: 1, events } }
}
