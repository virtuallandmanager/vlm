// apps/streaming/test/sweep.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sweepStaleLive } from '../src/sweep.js'

test('marks every listed key not live here as offline', async () => {
  const sent: string[] = []
  const n = await sweepStaleLive({
    liveKeys: async () => ['a', 'b'],
    notify: async (k, s) => { sent.push(`${k}:${s}`) },
    isLive: (k) => k === 'b',
    sleep: async () => {},
  })
  assert.equal(n, 1)
  assert.deepEqual(sent, ['a:offline'])
})

test('retries when the API is unreachable, then gives up', async () => {
  let tries = 0
  const n = await sweepStaleLive({
    liveKeys: async () => { tries++; throw new Error('down') },
    notify: async () => {},
    isLive: () => false,
    attempts: 3,
    sleep: async () => {},
  })
  assert.equal(tries, 3)
  assert.equal(n, 0)
})
