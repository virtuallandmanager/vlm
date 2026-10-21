import { describe, expect, it } from 'vitest'
import { parseIsoTime } from '../src/iso-time.js'

describe('parseIsoTime (the sandbox has no Date.parse)', () => {
  it('matches Date.parse on the server’s toISOString output, with or without millis', () => {
    const samples = [0, 1, 999, 86_399_999, 951_782_400_000, 1_709_164_800_000, 1_792_000_000_123, 4_102_444_799_999, -86_400_000]
    for (const ms of samples) {
      const iso = new Date(ms).toISOString()
      expect(parseIsoTime(iso), iso).toBe(ms)
      const noMillis = iso.replace(/\.\d{3}Z$/, 'Z')
      expect(parseIsoTime(noMillis), noMillis).toBe(Date.parse(noMillis))
    }
  })

  it('handles leap days and month ends', () => {
    for (const iso of ['2024-02-29T12:00:00.000Z', '2000-02-29T00:00:00Z', '2026-12-31T23:59:59.999Z', '2026-03-01T00:00:00.000Z']) {
      expect(parseIsoTime(iso), iso).toBe(Date.parse(iso))
    }
  })

  it('is NaN for anything else', () => {
    const bad: unknown[] = [
      undefined,
      null,
      42,
      '',
      'soon',
      '2026-10-21',
      '2026-10-21T10:00:00',
      '2026-10-21T10:00:00+02:00',
      '2026-10-21 10:00:00Z',
      '2026-13-01T00:00:00Z',
      '2026-02-30T00:00:00Z',
      '2025-02-29T00:00:00Z',
      '2026-10-21T24:00:00Z',
      '2026-10-21T10:60:00Z',
      '2026-10-21T10:00:60Z',
      '2026-10-21T10:00:00.12Z',
      '2026-10-21T10:00:00.1234Z',
      ' 2026-10-21T10:00:00Z',
      '2026-10-21T10:00:00Z ',
      '+002026-10-21T10:00:00Z',
    ]
    for (const s of bad) expect(parseIsoTime(s), String(s)).toBeNaN()
  })
})
