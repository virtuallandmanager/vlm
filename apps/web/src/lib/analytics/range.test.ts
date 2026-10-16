import { describe, it, expect } from 'vitest'
import { rangeQuery } from './range'

const now = new Date('2026-10-16T12:00:00Z')

describe('rangeQuery', () => {
  it('24h and 7d use hourly buckets ending now', () => {
    expect(rangeQuery('24h', now)).toEqual({ from: '2026-10-15T12:00:00.000Z', to: '2026-10-16T12:00:00.000Z', bucket: 'hour' })
    expect(rangeQuery('7d', now)).toMatchObject({ from: '2026-10-09T12:00:00.000Z', bucket: 'hour' })
  })
  it('30d uses daily buckets', () => {
    expect(rangeQuery('30d', now)).toMatchObject({ from: '2026-09-16T12:00:00.000Z', bucket: 'day' })
  })
  it('custom ranges are whole local days; over 7 days → daily buckets', () => {
    const r = rangeQuery('custom', now, { from: '2026-10-01', to: '2026-10-10' }) as any
    expect(new Date(r.from).getTime()).toBe(new Date(2026, 9, 1, 0, 0, 0, 0).getTime())
    expect(new Date(r.to).getTime()).toBe(new Date(2026, 9, 10, 23, 59, 59, 999).getTime())
    expect(r.bucket).toBe('day')
    expect((rangeQuery('custom', now, { from: '2026-10-14', to: '2026-10-15' }) as any).bucket).toBe('hour')
  })
  it('refuses inverted, missing and over-400-day custom ranges', () => {
    expect(rangeQuery('custom', now, { from: '2026-10-10', to: '2026-10-01' })).toHaveProperty('error')
    expect(rangeQuery('custom', now)).toHaveProperty('error')
    expect(rangeQuery('custom', now, { from: '2025-01-01', to: '2026-10-01' })).toHaveProperty('error')
  })
})
