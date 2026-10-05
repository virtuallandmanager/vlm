import { describe, it, expect, afterEach, vi } from 'vitest'
import { setSignedClaimLimiter } from '../src/routes/analytics-claims.js'
import { TokenBucketLimiter } from '../src/analytics/limiter.js'
import { testApp } from './helpers/factories.js'

// Its own file: the sweep interval is created once, when the routes are first registered.
describe('check-signed limiter sweep', () => {
  afterEach(() => vi.useRealTimers())

  it('sweeps the check-signed limiter every 60 s', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const l = new TokenBucketLimiter()
    const sweep = vi.spyOn(l, 'sweep')
    setSignedClaimLimiter(l)
    const app = await testApp()
    try {
      expect(sweep).not.toHaveBeenCalled()
      vi.advanceTimersByTime(60_000)
      expect(sweep).toHaveBeenCalledTimes(1)
      expect(sweep).toHaveBeenCalledWith(new Date().toISOString().slice(0, 10))
      vi.advanceTimersByTime(60_000)
      expect(sweep).toHaveBeenCalledTimes(2)
    } finally {
      await app.close()
    }
  })
})
