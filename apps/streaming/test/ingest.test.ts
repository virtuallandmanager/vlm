// apps/streaming/test/ingest.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createIngest, keyFromPath } from '../src/ingest.js'

function deps(authorize: (k: string) => Promise<boolean>, extra: Record<string, unknown> = {}) {
  const log: string[] = []
  return {
    log,
    d: {
      authorize,
      notify: async (k: string, s: string) => { log.push(`notify:${k}:${s}`) },
      startTranscode: (k: string) => { log.push(`start:${k}`) },
      stopTranscode: (k: string) => { log.push(`stop:${k}`) },
      reject: (id: string) => { log.push(`reject:${id}`) },
      removeOutput: (k: string) => { log.push(`rm:${k}`) },
      cleanupDelayMs: 20,
      ...extra,
    },
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('keyFromPath', () => {
  assert.equal(keyFromPath('/live/abc_123-x'), 'abc_123-x')
  assert.equal(keyFromPath('/live/../etc'), 'etc')
  assert.equal(keyFromPath('/live/bad key'), '')
  assert.equal(keyFromPath('/live/'), '')
})

test('authorized publish starts transcoding then notifies live; done stops, notifies offline, cleans up later', async () => {
  const { d, log } = deps(async () => true)
  const ing = createIngest(d)
  await ing.onPrePublish('s1', '/live/k1')
  assert.deepEqual(log, ['start:k1', 'notify:k1:live'])
  assert.equal(ing.isLive('k1'), true)
  await ing.onDonePublish('s1')
  assert.deepEqual(log.slice(2), ['stop:k1', 'notify:k1:offline'])
  await sleep(40)
  assert.equal(log.at(-1), 'rm:k1')
  assert.equal(ing.isLive('k1'), false)
})

for (const [name, authorize] of [
  ['denied', async () => false],
  ['throws (timeout / network)', async () => { throw new Error('timeout') }],
] as const) {
  test(`publish rejected when authorize ${name}: no transcode, no webhook`, async () => {
    const { d, log } = deps(authorize as () => Promise<boolean>)
    const ing = createIngest(d)
    await ing.onPrePublish('s1', '/live/k1')
    assert.deepEqual(log, ['reject:s1'])
    await ing.onDonePublish('s1')
    assert.deepEqual(log, ['reject:s1'])
  })
}

test('invalid key path is rejected without calling authorize', async () => {
  let called = false
  const { d, log } = deps(async () => { called = true; return true })
  await createIngest(d).onPrePublish('s1', '/live/bad key')
  assert.equal(called, false)
  assert.deepEqual(log, ['reject:s1'])
})

test('publisher leaves while authorize is in flight: nothing starts', async () => {
  let release!: (v: boolean) => void
  const { d, log } = deps(() => new Promise<boolean>((r) => { release = r }))
  const ing = createIngest(d)
  const pending = ing.onPrePublish('s1', '/live/k1')
  await ing.onDonePublish('s1')
  release(true)
  await pending
  assert.deepEqual(log, [])
  assert.equal(ing.isLive('k1'), false)
})

test('re-publish within the cleanup window keeps the new output', async () => {
  const { d, log } = deps(async () => true)
  const ing = createIngest(d)
  await ing.onPrePublish('s1', '/live/k1')
  await ing.onDonePublish('s1')
  await ing.onPrePublish('s2', '/live/k1')
  await sleep(40)
  assert.ok(!log.includes('rm:k1'), log.join(','))
})

test('capacity: publishes beyond maxStreams are rejected', async () => {
  const { d, log } = deps(async () => true, { maxStreams: 1 })
  const ing = createIngest(d)
  await ing.onPrePublish('s1', '/live/k1')
  await ing.onPrePublish('s2', '/live/k2')
  assert.ok(log.includes('reject:s2'))
  assert.ok(!log.includes('start:k2'))
  assert.equal(ing.liveCount(), 1)
})
