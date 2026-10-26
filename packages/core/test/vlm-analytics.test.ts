import { describe, it, expect, vi } from 'vitest'
import { VLM } from '../src/VLM.js'
import type { Collector } from '../src/analytics/collector.js'

describe('VLM analytics attachment', () => {
  it('destroy() detaches the shared collector without destroying it', async () => {
    const collector = { destroy: vi.fn(async () => {}), track: vi.fn() } as unknown as Collector
    const vlm = new VLM({} as any)
    vlm.attachAnalytics(collector)
    vlm.track('before')
    expect(collector.track).toHaveBeenCalledWith('before', undefined)
    await vlm.destroy()
    expect(collector.destroy).not.toHaveBeenCalled()
    vlm.track('after')
    expect(collector.track).toHaveBeenCalledTimes(1)
  })
})
