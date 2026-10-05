import { ANALYTICS_LIMITS, type IngestBatch, type IngestResponse } from 'vlm-shared'
import type { EventQueue } from './queue.js'
import type { AnalyticsTransport } from './transport.js'

export interface UploaderOptions {
  url: string
  queue: EventQueue
  transport: AnalyticsTransport
  envelope: (sessionId: string) => Omit<IngestBatch, 'events'>
  now: () => number
  random?: () => number
  onResponse?: (r: IngestResponse) => void
  log?: (msg: string) => void
}

export class Uploader {
  private inFlight = false
  private lastFlushAt: number
  private nextAttemptAt = 0
  private failures = 0
  private warnedRejected = false

  constructor(private opts: UploaderOptions) {
    this.lastFlushAt = opts.now()
  }

  /** Starts a send if one is due; returns its promise, or null if nothing was sent. */
  maybeFlush(force = false): Promise<void> | null {
    const { queue, now } = this.opts
    if (this.inFlight || queue.size === 0) return null
    const t = now()
    if (t < this.nextAttemptAt) return null
    const due =
      force ||
      queue.hasHighPriority() ||
      queue.size >= ANALYTICS_LIMITS.flushAtCount ||
      t - this.lastFlushAt >= ANALYTICS_LIMITS.flushIntervalMs
    if (!due) return null
    const taken = queue.take(ANALYTICS_LIMITS.maxBatchEvents)
    if (!taken) return null
    this.inFlight = true
    this.lastFlushAt = t
    return this.send(taken.sessionId, taken.events).finally(() => {
      this.inFlight = false
    })
  }

  private backoffMs(): number {
    const base = Math.min(ANALYTICS_LIMITS.backoffMaxMs, ANALYTICS_LIMITS.backoffMinMs * 2 ** (this.failures - 1))
    const r = this.opts.random ? this.opts.random() : Math.random()
    return Math.round(base * (0.5 + 0.5 * r))
  }

  private async send(sessionId: string, events: IngestBatch['events']): Promise<void> {
    const { transport, url, queue, envelope, now, onResponse, log } = this.opts
    const res = await transport.send(url, { ...envelope(sessionId), events })
    if (res.status >= 200 && res.status < 300) {
      this.failures = 0
      if (onResponse && res.body && typeof res.body === 'object') onResponse(res.body as IngestResponse)
      return
    }
    if (res.status === 429) {
      queue.putBack(sessionId, events)
      const retryAfter = (res.body as { retryAfter?: number } | undefined)?.retryAfter
      this.failures++
      this.nextAttemptAt = now() + (typeof retryAfter === 'number' ? retryAfter * 1000 : this.backoffMs())
      return
    }
    if (res.status === 0 || res.status >= 500) {
      queue.putBack(sessionId, events)
      this.failures++
      this.nextAttemptAt = now() + this.backoffMs()
      return
    }
    if (!this.warnedRejected) {
      this.warnedRejected = true
      log?.(`[VLM analytics] batch rejected (${res.status}): ${JSON.stringify(res.body)}`)
    }
  }
}
