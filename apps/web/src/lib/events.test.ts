import { describe, it, expect } from 'vitest'
import { dateParts, eventTiming, listEvents } from './events'

const now = Date.parse('2026-10-20T12:00:00Z')
const ev = (name: string, startTime: string | null, endTime: string | null, description: string | null = null) => ({ name, startTime, endTime, description })

describe('event list helpers', () => {
  it('places an event before, during or after now', () => {
    expect(eventTiming(ev('a', '2026-10-21T00:00:00Z', '2026-10-28T00:00:00Z'), now)).toBe('upcoming')
    expect(eventTiming(ev('b', '2026-10-14T00:00:00Z', '2026-10-21T00:00:00Z'), now)).toBe('live')
    expect(eventTiming(ev('c', '2026-10-07T00:00:00Z', '2026-10-14T00:00:00Z'), now)).toBe('past')
    expect(eventTiming(ev('d', null, null), now)).toBe('unscheduled')
    expect(eventTiming(ev('e', '2026-10-01T00:00:00Z', null), now)).toBe('past')
  })

  it('filters by search and timing, and sorts by start or name', () => {
    const events = [
      ev('Week 3', '2026-10-21T00:00:00Z', '2026-10-28T00:00:00Z'),
      ev('Week 1', '2026-10-07T00:00:00Z', '2026-10-14T00:00:00Z', 'ghost towns'),
      ev('Someday', null, null),
      ev('Week 2', '2026-10-14T00:00:00Z', '2026-10-21T00:00:00Z'),
    ]
    expect(listEvents(events, '', 'all', 'start', now).map((e) => e.name)).toEqual(['Week 1', 'Week 2', 'Week 3', 'Someday'])
    expect(listEvents(events, '', 'all', 'name', now).map((e) => e.name)).toEqual(['Someday', 'Week 1', 'Week 2', 'Week 3'])
    expect(listEvents(events, '', 'live', 'start', now).map((e) => e.name)).toEqual(['Week 2'])
    expect(listEvents(events, ' GHOST ', 'all', 'start', now).map((e) => e.name)).toEqual(['Week 1'])
  })

  it('splits a time into date and time of day', () => {
    const parts = dateParts('2026-10-07T20:00:00')
    expect(parts).toEqual({ date: 'Oct 7, 2026', time: '8:00 PM' })
    expect(dateParts(null)).toBeNull()
    expect(dateParts('nope')).toBeNull()
  })
})
