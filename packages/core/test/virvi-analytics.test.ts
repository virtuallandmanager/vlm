import { describe, it, expect, vi } from 'vitest'
import { Virvi } from '../src/Virvi.js'
import type { Collector } from '../src/analytics/collector.js'

describe('Virvi analytics attachment', () => {
  it('destroy() detaches the shared collector without destroying it', async () => {
    const collector = { destroy: vi.fn(async () => {}), track: vi.fn() } as unknown as Collector
    const virvi = new Virvi({} as any)
    virvi.attachAnalytics(collector)
    virvi.track('before')
    expect(collector.track).toHaveBeenCalledWith('before', undefined)
    await virvi.destroy()
    expect(collector.destroy).not.toHaveBeenCalled()
    virvi.track('after')
    expect(collector.track).toHaveBeenCalledTimes(1)
  })
})
