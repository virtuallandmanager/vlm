import { ANALYTICS_LIMITS } from 'vlm-shared'

interface Bucket {
  tokens: number
  at: number
  capacity: number
}

export class TokenBucketLimiter {
  private buckets = new Map<string, Bucket>()
  private counters = new Map<string, number>()

  constructor(private now: () => number = Date.now) {}

  private refill(key: string, capacity: number, refillPerSec: number): Bucket {
    const t = this.now()
    const b = this.buckets.get(key) ?? { tokens: capacity, at: t, capacity }
    b.tokens = Math.min(capacity, b.tokens + ((t - b.at) / 1000) * refillPerSec)
    b.at = t
    this.buckets.set(key, b)
    return b
  }

  peek(key: string, capacity: number, refillPerSec: number): number {
    return this.refill(key, capacity, refillPerSec).tokens
  }

  take(key: string, cost: number, capacity: number, refillPerSec: number): { ok: boolean; retryAfterMs: number; available: number } {
    const b = this.refill(key, capacity, refillPerSec)
    // A cost above capacity can never succeed: reject without a retry hint and without consuming.
    if (cost > capacity) return { ok: false, retryAfterMs: 0, available: b.tokens }
    if (b.tokens >= cost) {
      b.tokens -= cost
      return { ok: true, retryAfterMs: 0, available: b.tokens }
    }
    return { ok: false, retryAfterMs: Math.ceil(((cost - b.tokens) / refillPerSec) * 1000), available: b.tokens }
  }

  /** Increment a plain counter (e.g. per-day caps) and return the new value. */
  count(key: string, by: number): number {
    const v = (this.counters.get(key) ?? 0) + by
    this.counters.set(key, v)
    return v
  }

  counter(key: string): number {
    return this.counters.get(key) ?? 0
  }

  /** Drop full buckets and old counters so memory stays bounded. */
  sweep(today?: string): void {
    for (const [k, b] of this.buckets) if (b.tokens >= b.capacity) this.buckets.delete(k)
    if (today) for (const k of this.counters.keys()) if (!k.endsWith(today)) this.counters.delete(k)
  }
}

export const INGEST_LIMITS = {
  request: { capacity: 3, refillPerSec: 0.5 },
  signerEvents: { capacity: 200, refillPerSec: 200 / 60 },
  unverifiedEvents: { capacity: ANALYTICS_LIMITS.maxBatchEvents, refillPerSec: 1 },
  sceneEvents: { capacity: 5_000, refillPerSec: 5_000 / 60 },
  previewDaily: 10_000,
} as const

/** Per-requester limits (request rate and event volume). Run before resolving the scene. */
export function checkRequesterLimits(
  l: TokenBucketLimiter,
  i: { requesterKey: string; verified: boolean; eventCount: number },
): { ok: true } | { ok: false; retryAfterMs: number; tooLarge?: true } {
  const ev = i.verified ? INGEST_LIMITS.signerEvents : INGEST_LIMITS.unverifiedEvents
  if (i.eventCount > ev.capacity) return { ok: false, retryAfterMs: 0, tooLarge: true }
  const req = l.take(`req:${i.requesterKey}`, 1, INGEST_LIMITS.request.capacity, INGEST_LIMITS.request.refillPerSec)
  if (!req.ok) return { ok: false, retryAfterMs: req.retryAfterMs }

  const evs = l.take(`ev:${i.requesterKey}`, i.eventCount, ev.capacity, ev.refillPerSec)
  if (!evs.ok) return { ok: false, retryAfterMs: evs.retryAfterMs }
  return { ok: true }
}

/** Per-scene limits (preview daily cap, scene-wide position sampling). Run after resolving the scene. */
export function checkSceneLimits(
  l: TokenBucketLimiter,
  i: { sceneId: string; isPreview: boolean; eventCount: number; posCount: number; dayKey: string },
): { ok: true; keepPosProbability: number } | { ok: false; retryAfterMs: number } {
  if (i.isPreview) {
    const dayKey = `preview:${i.sceneId}:${i.dayKey}`
    if (l.counter(dayKey) + i.eventCount > INGEST_LIMITS.previewDaily) return { ok: false, retryAfterMs: 3_600_000 }
    l.count(dayKey, i.eventCount)
    return { ok: true, keepPosProbability: 1 }
  }

  const sceneKey = `scene:${i.sceneId}`
  const { capacity, refillPerSec } = INGEST_LIMITS.sceneEvents
  const available = l.peek(sceneKey, capacity, refillPerSec)
  if (available >= i.eventCount) {
    l.take(sceneKey, i.eventCount, capacity, refillPerSec)
    return { ok: true, keepPosProbability: 1 }
  }
  // Over the scene budget: keep every non-position event, sample positions with what's left.
  const nonPos = i.eventCount - i.posCount
  const spare = Math.max(0, available - nonPos)
  l.take(sceneKey, Math.min(available, i.eventCount), capacity, refillPerSec)
  const keep = i.posCount > 0 ? Math.max(0.05, Math.min(1, spare / i.posCount)) : 1
  return { ok: true, keepPosProbability: keep }
}

export function checkIngestLimits(
  l: TokenBucketLimiter,
  i: { requesterKey: string; verified: boolean; sceneId: string; isPreview: boolean; eventCount: number; posCount: number; dayKey: string },
): { ok: true; keepPosProbability: number } | { ok: false; retryAfterMs: number; tooLarge?: true } {
  const requester = checkRequesterLimits(l, i)
  if (!requester.ok) return requester
  return checkSceneLimits(l, i)
}
