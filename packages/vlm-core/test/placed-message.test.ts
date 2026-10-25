import { describe, it, expect } from 'vitest'
import { placedMessage } from '../src/placed-message.js'

const dest = (o: Partial<{ mode: 'virvi' | 'sign'; status: string; granted: boolean }> = {}) => ({ mode: 'virvi' as const, status: 'ok', granted: true, ...o })

describe('placedMessage', () => {
  it('promises an automatic deploy only when Virvi holds the permission and nothing is blocking it', () => {
    expect(placedMessage('Lamp', dest())).toEqual({ text: 'Placed Lamp — Virvi is adding it to your World; it appears in a minute or two', publish: false })
    expect(placedMessage('Lamp', dest({ status: 'unreachable' })).text).toMatch(/Virvi is adding it/)
    expect(placedMessage('Lamp', dest({ granted: false })).text).not.toMatch(/Virvi is adding it/)
    expect(placedMessage('Lamp', dest({ granted: false })).text).toMatch(/permission/)
    expect(placedMessage('Lamp', dest({ status: 'over_budget' })).text).toMatch(/limits/)
    expect(placedMessage('Lamp', dest({ status: 'needs_review' })).text).toMatch(/Deploy page/)
  })

  it('mode sign offers the Publish button unless something blocks it', () => {
    expect(placedMessage('Lamp', dest({ mode: 'sign', granted: false }))).toEqual({ text: 'Placed Lamp — publish it to see it in your World', publish: true })
    expect(placedMessage('Lamp', dest({ mode: 'sign', status: 'over_budget' })).publish).toBe(false)
  })

  it('never names a domain', () => {
    const all = [
      placedMessage('Lamp', null),
      ...(['virvi', 'sign'] as const).flatMap((mode) =>
        ['ok', 'needs_review', 'over_budget', 'unreachable'].flatMap((status) => [true, false].map((granted) => placedMessage('Lamp', { mode, status, granted })))),
    ]
    for (const m of all) expect(m.text).not.toMatch(/vlm\.gg|virvi\.(gg|com)|https?:/)
    expect(placedMessage('Lamp', null).text).toMatch(/Deploy page/)
  })
})
