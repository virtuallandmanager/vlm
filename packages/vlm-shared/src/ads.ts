export type AdShape = '16:9' | '1:1' | '9:16' | '2:5'
export const AD_SHAPES: readonly AdShape[] = ['16:9', '1:1', '9:16', '2:5']

export type AdFormats = 'image' | 'video' | 'both'

export interface Quat {
  x: number
  y: number
  z: number
  w: number
}

export const AD_LIMITS = {
  imageSeconds: 10,
  freqCapPerHour: 6,
  maxVideoAdsPerScene: 2,
  idleMs: 60_000,
  minShortSideM: 0.5,
  onScreenMaxDistanceM: 25,
  onScreenHalfAngleDeg: 35,
  onScreenMinApparent: 0.04,
  onScreenMinMs: 1000,
  hoverMaxDistanceM: 20,
  serveRefreshMs: 300_000,
  eventsFlushMs: 10_000,
  eventsFlushCount: 20,
  maxEventsPerBatch: 50,
  playlistItemsBetweenAds: 1,
} as const

export interface AdItem {
  adId: string
  creativeId: string
  kind: 'image' | 'video'
  url: string
  clickUrl: string
  house: boolean
}

export interface AdServeRequest {
  elementIds: string[]
}

export interface AdServeResponse {
  spaces: Record<string, { paused: boolean; ads: AdItem[] }>
}

export type AdLevel = 'scene' | 'screen' | 'look' | 'click'
const AD_LEVELS = new Set<string>(['scene', 'screen', 'look', 'click'])

export interface AdEvent {
  adId: string
  elementId: string
  level: AdLevel
  t: number
  dwellMs?: number
}

export interface AdEventBatch {
  v: 1
  sessionId: string
  events: AdEvent[]
}

export type AdEventBatchCheck = { ok: true; batch: AdEventBatch } | { ok: false; error: string }

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function str(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.length >= 1 && v.length <= max
}

export function checkAdEventBatch(body: unknown): AdEventBatchCheck {
  if (!isObj(body)) return { ok: false, error: 'batch must be an object' }
  if (body.v !== 1) return { ok: false, error: 'v must be 1' }
  if (!str(body.sessionId, 100)) return { ok: false, error: 'sessionId is required' }
  if (!Array.isArray(body.events) || body.events.length < 1 || body.events.length > AD_LIMITS.maxEventsPerBatch) {
    return { ok: false, error: `events must contain 1-${AD_LIMITS.maxEventsPerBatch} items` }
  }
  const events: AdEvent[] = []
  for (const e of body.events) {
    if (!isObj(e)) return { ok: false, error: 'event must be an object' }
    if (!str(e.adId, 100) || !str(e.elementId, 100)) return { ok: false, error: 'event.adId and event.elementId are required' }
    if (typeof e.level !== 'string' || !AD_LEVELS.has(e.level)) return { ok: false, error: `unknown event level: ${String(e.level)}` }
    if (typeof e.t !== 'number' || !Number.isFinite(e.t)) return { ok: false, error: 'event.t must be a number' }
    if (e.dwellMs !== undefined) {
      if (e.level !== 'look') return { ok: false, error: 'event.dwellMs is only allowed on look events' }
      if (typeof e.dwellMs !== 'number' || !Number.isFinite(e.dwellMs) || e.dwellMs < 0) {
        return { ok: false, error: 'event.dwellMs must be a non-negative number' }
      }
    }
    events.push({ adId: e.adId, elementId: e.elementId, level: e.level as AdLevel, t: e.t, ...(e.dwellMs !== undefined ? { dwellMs: e.dwellMs } : {}) })
  }
  return { ok: true, batch: { v: 1, sessionId: body.sessionId, events } }
}
