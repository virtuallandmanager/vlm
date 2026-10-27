import { describe, expect, it } from 'vitest'
import { AD_LIMITS, AD_SHAPES, checkAdEventBatch, VideoSourceType } from '@virvixr/shared'

const ev = (over: Record<string, unknown> = {}) => ({ adId: 'ad1', elementId: 'el1', level: 'scene', t: 1000, ...over })
const batch = (over: Record<string, unknown> = {}) => ({ v: 1, sessionId: 's1', events: [ev()], ...over })

describe('checkAdEventBatch', () => {
  it('accepts a valid batch', () => {
    const body = batch({ events: [ev(), ev({ level: 'look', dwellMs: 1500 }), ev({ level: 'click' })] })
    const res = checkAdEventBatch(body)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.batch.events).toHaveLength(3)
  })

  it('rejects unknown level, more than 50 events, missing sessionId, and dwellMs on a non-look event', () => {
    expect(checkAdEventBatch(batch({ events: [ev({ level: 'hover' })] })).ok).toBe(false)
    expect(checkAdEventBatch(batch({ events: Array.from({ length: AD_LIMITS.maxEventsPerBatch + 1 }, () => ev()) })).ok).toBe(false)
    expect(checkAdEventBatch(batch({ sessionId: undefined })).ok).toBe(false)
    expect(checkAdEventBatch(batch({ events: [ev({ level: 'click', dwellMs: 10 })] })).ok).toBe(false)
  })
})

describe('ad vocabulary', () => {
  it('AD_SHAPES is exactly the four shapes', () => {
    expect([...AD_SHAPES]).toEqual(['16:9', '1:1', '9:16', '2:5'])
  })

  it('video modes', () => {
    expect(VideoSourceType.ADS).toBe(4)
    expect(VideoSourceType.PLAYLIST_ADS).toBe(5)
  })
})
