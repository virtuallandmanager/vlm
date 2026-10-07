import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createIngest, keyFromPath } from '../src/ingest.js'

type Auth = (k: string) => Promise<string | null>
function deps(authorize: Auth, extra: Record<string, unknown> = {}) {
  const log: string[] = []
  return {
    log,
    d: {
      authorize,
      notify: async (k: string, s: string) => { log.push(`notify:${k}:${s}`) },
      startTranscode: (k: string, _p: string, pid: string) => { log.push(`start:${k}:${pid}`) },
      stopTranscode: (k: string) => { log.push(`stop:${k}`) },
      waitForPlaylist: async () => true,
      reject: (id: string) => { log.push(`reject:${id}`) },
      removeOutput: (pid: string) => { log.push(`rm:${pid}`) },
      cleanupDelayMs: 20,
      ...extra,
    },
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const ok: Auth = async (k) => `pb-${k}`

test('keyFromPath', () => {
  assert.equal(keyFromPath('/live/abc_123-x'), 'abc_123-x')
  assert.equal(keyFromPath('/live/../etc'), 'etc')
  assert.equal(keyFromPath('/live/bad key'), '')
  assert.equal(keyFromPath('/live/'), '')
})

test('authorized publish: fresh output, transcode under the playback id, live once the playlist exists; done → offline, cleanup later', async () => {
  const { d, log } = deps(ok)
  const ing = createIngest(d)
  await ing.onPrePublish('s1', '/live/k1')
  assert.deepEqual(log, ['rm:pb-k1', 'start:k1:pb-k1', 'notify:k1:live'])
  assert.equal(ing.isLive('k1'), true)
  await ing.onDonePublish('s1')
  assert.deepEqual(log.slice(3), ['stop:k1', 'notify:k1:offline'])
  await sleep(40)
  assert.equal(log.at(-1), 'rm:pb-k1')
  assert.equal(ing.isLive('k1'), false)
})

for (const [name, authorize] of [
  ['denied', async () => null],
  ['throws (timeout / network)', async () => { throw new Error('timeout') }],
] as const) {
  test(`publish rejected when authorize ${name}: no transcode, no webhook`, async () => {
    const { d, log } = deps(authorize as Auth)
    const ing = createIngest(d)
    await ing.onPrePublish('s1', '/live/k1')
    assert.deepEqual(log, ['reject:s1'])
    await ing.onDonePublish('s1')
    assert.deepEqual(log, ['reject:s1'])
  })
}

test('invalid key path is rejected without calling authorize', async () => {
  let called = false
  const { d, log } = deps(async () => { called = true; return 'pb' })
  await createIngest(d).onPrePublish('s1', '/live/bad key')
  assert.equal(called, false)
  assert.deepEqual(log, ['reject:s1'])
})

test('publisher leaves while authorize is in flight: nothing starts', async () => {
  let release!: (v: string) => void
  const { d, log } = deps(() => new Promise<string>((r) => { release = r }))
  const ing = createIngest(d)
  const pending = ing.onPrePublish('s1', '/live/k1')
  await ing.onDonePublish('s1')
  release('pb-k1')
  await pending
  assert.deepEqual(log, [])
  assert.equal(ing.isLive('k1'), false)
})

test('playlist never appears: transcode stopped, publish rejected, never reported live', async () => {
  const { d, log } = deps(ok, { waitForPlaylist: async () => false })
  const ing = createIngest(d)
  await ing.onPrePublish('s1', '/live/k1')
  assert.deepEqual(log, ['rm:pb-k1', 'start:k1:pb-k1', 'stop:k1', 'reject:s1', 'rm:pb-k1'])
  assert.equal(ing.isLive('k1'), false)
  assert.equal(ing.liveCount(), 0)
})

test('publisher leaves while waiting for the playlist: stopped, neither live nor offline sent', async () => {
  let ready!: (v: boolean) => void
  const { d, log } = deps(ok, { waitForPlaylist: () => new Promise<boolean>((r) => { ready = r }) })
  const ing = createIngest(d)
  const pending = ing.onPrePublish('s1', '/live/k1')
  await sleep(5)
  await ing.onDonePublish('s1')
  ready(true)
  await pending
  assert.ok(log.includes('stop:k1'))
  assert.ok(!log.some((l) => l.startsWith('notify:')), log.join(','))
  assert.equal(ing.isLive('k1'), false)
})

test('offline is sent after an in-flight live notify (per-key order)', async () => {
  const sent: string[] = []
  let releaseLive!: () => void
  const { d } = deps(ok, {
    notify: (k: string, s: string) => s === 'live'
      ? new Promise<void>((r) => { releaseLive = () => { sent.push(`${k}:live`); r() } })
      : (sent.push(`${k}:offline`), Promise.resolve()),
  })
  const ing = createIngest(d)
  const pending = ing.onPrePublish('s1', '/live/k1')
  await sleep(5)
  const done = ing.onDonePublish('s1')
  await sleep(5)
  releaseLive()
  await Promise.all([pending, done])
  await sleep(5)
  assert.deepEqual(sent, ['k1:live', 'k1:offline'])
})

test('re-publish within the cleanup window: old output replaced before start, new output not deleted', async () => {
  const { d, log } = deps(ok)
  const ing = createIngest(d)
  await ing.onPrePublish('s1', '/live/k1')
  await ing.onDonePublish('s1')
  const mark = log.length
  await ing.onPrePublish('s2', '/live/k1')
  await sleep(40)
  assert.deepEqual(log.slice(mark), ['rm:pb-k1', 'start:k1:pb-k1', 'notify:k1:live'])
})

test('capacity: publishes beyond maxStreams are rejected', async () => {
  const { d, log } = deps(ok, { maxStreams: 1 })
  const ing = createIngest(d)
  await ing.onPrePublish('s1', '/live/k1')
  await ing.onPrePublish('s2', '/live/k2')
  assert.ok(log.includes('reject:s2'))
  assert.ok(!log.some((l) => l.startsWith('start:k2')))
  assert.equal(ing.liveCount(), 1)
})
