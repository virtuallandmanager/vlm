import { describe, it, expect } from 'vitest'
import { lastSeenLabel, setupSteps, hyperfyErrorMessage } from './hyperfy'

const now = new Date('2026-10-20T12:00:00Z')
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString()

describe('lastSeenLabel', () => {
  it('says never connected for null', () => {
    expect(lastSeenLabel(null, now)).toBe('Never connected')
  })
  it('says connected just now under 2 minutes', () => {
    expect(lastSeenLabel(ago(30_000), now)).toBe('Connected just now')
    expect(lastSeenLabel(ago(119_000), now)).toBe('Connected just now')
  })
  it('uses minutes under an hour', () => {
    expect(lastSeenLabel(ago(5 * 60_000), now)).toBe('Last seen 5 min ago')
  })
  it('uses hours under a day', () => {
    expect(lastSeenLabel(ago(3 * 3_600_000), now)).toBe('Last seen 3 h ago')
  })
  it('uses the date after a day', () => {
    expect(lastSeenLabel('2026-10-18T09:00:00Z', now)).toBe('Last seen Oct 18')
  })
})

describe('setupSteps', () => {
  it('gives the four steps with the feed url', () => {
    expect(setupSteps('https://api.vlm.gg')).toEqual([
      'Download the VLM app and drag vlm.hyp into your Hyperfy world.',
      "Open the app's settings and paste your world key into World key.",
      'Leave Feed URL as https://api.vlm.gg unless VLM support tells you otherwise.',
      'Your scene appears within a few seconds and follows your edits.',
    ])
  })
})

describe('hyperfyErrorMessage', () => {
  it('explains an upgrade is needed', () => {
    expect(hyperfyErrorMessage(new Error('upgrade_required'))).toMatch(/plan/i)
  })
  it('explains a too-long name', () => {
    expect(hyperfyErrorMessage(Object.assign(new Error('x'), { status: 400 }))).toMatch(/100/)
  })
  it('falls back', () => {
    expect(hyperfyErrorMessage(new Error('API error 500'))).toBe('Something went wrong. Try again in a moment.')
  })
})
