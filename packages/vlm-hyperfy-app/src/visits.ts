import { HYPERFY_ANALYTICS_LIMITS, HYPERFY_FEED, type HyperfyVisitEvent } from 'vlm-shared'
import type { ScriptFetch, ScriptSetTimeout } from './poller.js'

export interface VisitRecorderOptions {
  feedUrl: string
  worldKey: string
  fetch: ScriptFetch
  setTimeout: ScriptSetTimeout
  now: () => number
  getPlayers: () => Array<{ id: string; position: { x: number; y: number; z: number } }>
}

const MAX_QUEUED = 1_000

/**
 * Queues visitor enter, leave and position events and posts them to VLM's analytics in batches.
 * Positions are sampled every positionSampleMs for each present player; the queue flushes every
 * analyticsFlushMs. A failed post keeps the events, up to 1,000, dropping the oldest.
 */
export class VisitRecorder {
  private queue: HyperfyVisitEvent[] = []
  private running = false

  constructor(private readonly opts: VisitRecorderOptions) {}

  start(): void {
    if (this.running) return
    this.running = true
    this.opts.setTimeout(() => this.sample(), HYPERFY_FEED.positionSampleMs)
    this.opts.setTimeout(() => void this.flush(), HYPERFY_FEED.analyticsFlushMs)
  }

  stop(): void {
    this.running = false
  }

  enter(playerId: string): void {
    this.push({ type: 'enter', playerId, t: this.opts.now() })
  }

  leave(playerId: string): void {
    this.push({ type: 'leave', playerId, t: this.opts.now() })
  }

  private push(event: HyperfyVisitEvent): void {
    this.queue.push(event)
    this.cap()
  }

  private cap(): void {
    if (this.queue.length > MAX_QUEUED) this.queue.splice(0, this.queue.length - MAX_QUEUED)
  }

  private sample(): void {
    if (!this.running) return
    const t = this.opts.now()
    for (const p of this.opts.getPlayers()) {
      const { x, y, z } = p.position
      if ([x, y, z].every(Number.isFinite)) this.push({ type: 'pos', playerId: p.id, t, x, y, z })
    }
    this.opts.setTimeout(() => this.sample(), HYPERFY_FEED.positionSampleMs)
  }

  private async flush(): Promise<void> {
    if (!this.running) return
    while (this.queue.length) {
      const events = this.queue.splice(0, HYPERFY_ANALYTICS_LIMITS.maxBatchEvents)
      if (!(await this.post(events))) {
        // Put them back in front of anything queued meanwhile; the cap drops the oldest.
        this.queue = events.concat(this.queue)
        this.cap()
        break
      }
    }
    this.opts.setTimeout(() => void this.flush(), HYPERFY_FEED.analyticsFlushMs)
  }

  private async post(events: HyperfyVisitEvent[]): Promise<boolean> {
    try {
      const res = await this.opts.fetch(`${this.opts.feedUrl}/api/hyperfy/analytics`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.opts.worldKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ v: 1, events }),
      })
      return !!res?.ok
    } catch {
      return false
    }
  }
}
