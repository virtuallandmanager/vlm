// Event list helpers for the Events page.

export type EventTiming = 'upcoming' | 'live' | 'past' | 'unscheduled'
export type EventFilter = 'all' | 'upcoming' | 'live' | 'past'
export type EventSort = 'start' | 'name'

type ListedEvent = { name: string; description?: string | null; startTime?: string | null; endTime?: string | null }

/** Where an event sits relative to `now`. An event without an end runs until its start has passed. */
export function eventTiming(e: ListedEvent, now = Date.now()): EventTiming {
  const start = e.startTime ? Date.parse(e.startTime) : NaN
  const end = e.endTime ? Date.parse(e.endTime) : NaN
  if (Number.isNaN(start)) return Number.isNaN(end) ? 'unscheduled' : end < now ? 'past' : 'upcoming'
  if (start > now) return 'upcoming'
  if (Number.isNaN(end) || end >= now) return Number.isNaN(end) ? 'past' : 'live'
  return 'past'
}

/** Events matching the search, the timing filter and the sort. Unscheduled events show only under "all". */
export function listEvents<T extends ListedEvent>(events: T[], query: string, filter: EventFilter, sort: EventSort, now = Date.now()): T[] {
  const q = query.trim().toLowerCase()
  const shown = events.filter((e) =>
    (!q || e.name.toLowerCase().includes(q) || (e.description ?? '').toLowerCase().includes(q)) &&
    (filter === 'all' || eventTiming(e, now) === filter))
  const startOf = (e: T) => (e.startTime ? Date.parse(e.startTime) : Infinity)
  return [...shown].sort((a, b) => (sort === 'name' ? a.name.localeCompare(b.name) : startOf(a) - startOf(b)))
}

/** "Oct 7, 2026" and "8:00 PM" for the table's two-line date cells, or null when there is no time. */
export function dateParts(iso: string | null | undefined): { date: string; time: string } | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return {
    date: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
    time: d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
  }
}
