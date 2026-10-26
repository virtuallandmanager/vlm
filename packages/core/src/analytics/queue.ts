import { ANALYTICS_LIMITS, isHighPriority, type AnalyticsEvent } from 'vlm-shared'

interface Entry {
  sessionId: string
  event: AnalyticsEvent
}

export class EventQueue {
  private items: Entry[] = []

  constructor(private maxSize: number = ANALYTICS_LIMITS.maxQueue) {}

  get size(): number {
    return this.items.length
  }

  push(sessionId: string, event: AnalyticsEvent): void {
    this.items.push({ sessionId, event })
    this.trim()
  }

  hasHighPriority(): boolean {
    return this.items.some((i) => isHighPriority(i.event))
  }

  /** The leading run of events that share one session id, up to `max`. */
  take(max: number): { sessionId: string; events: AnalyticsEvent[] } | null {
    if (this.items.length === 0) return null
    const sessionId = this.items[0].sessionId
    let n = 0
    while (n < this.items.length && n < max && this.items[n].sessionId === sessionId) n++
    const taken = this.items.splice(0, n)
    return { sessionId, events: taken.map((i) => i.event) }
  }

  putBack(sessionId: string, events: AnalyticsEvent[]): void {
    this.items = [...events.map((event) => ({ sessionId, event })), ...this.items]
    this.trim()
  }

  private trim(): void {
    while (this.items.length > this.maxSize) {
      let i = this.items.findIndex((x) => x.event.type === 'pos')
      if (i < 0) i = this.items.findIndex((x) => x.event.type === 'session.heartbeat')
      if (i < 0) i = 0
      this.items.splice(i, 1)
    }
  }
}
