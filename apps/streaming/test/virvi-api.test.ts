// apps/streaming/test/virvi-api.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createApiClient } from '../src/virvi-api.js'

const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })

test('authorize returns the playback id only for 200 { ok: true, playbackId }, sends the secret and the key', async () => {
  const calls: [string, RequestInit][] = []
  const fetch = async (url: any, init: any) => { calls.push([String(url), init]); return res(200, { ok: true, playbackId: 'pb_1' }) }
  const api = createApiClient({ apiUrl: 'https://api.test/', webhookKey: 'sec', fetch })
  assert.equal(await api.authorize('k1'), 'pb_1')
  assert.equal(calls[0][0], 'https://api.test/api/streaming/authorize')
  assert.equal((calls[0][1].headers as any)['X-Webhook-Key'], 'sec')
  assert.equal(calls[0][1].body, JSON.stringify({ streamKey: 'k1' }))
  for (const r of [res(403, { error: 'unknown_key' }), res(401, {}), res(200, { ok: false }), res(200, { ok: true }), res(200, { ok: true, playbackId: '../x' }), new Response('oops', { status: 200 })]) {
    assert.equal(await createApiClient({ apiUrl: 'https://api.test', webhookKey: 'sec', fetch: async () => r }).authorize('k1'), null)
  }
})

test('authorize times out (fail closed)', async () => {
  const fetch = (_u: any, init: any) => new Promise<Response>((_, reject) => {
    const keep = setTimeout(() => {}, 2000)
    init.signal.addEventListener('abort', () => { clearTimeout(keep); reject(init.signal.reason) })
  })
  const api = createApiClient({ apiUrl: 'https://api.test', webhookKey: 'sec', fetch, timeoutMs: 30 })
  await assert.rejects(api.authorize('k1'))
})

test('notify posts streamKey/status; liveKeys returns the list', async () => {
  const bodies: any[] = []
  const fetch = async (url: any, init: any) => {
    if (String(url).endsWith('/live-keys')) return res(200, { streamKeys: ['a', 'b'] })
    bodies.push(JSON.parse(init.body))
    return res(200, { ok: true })
  }
  const api = createApiClient({ apiUrl: 'https://api.test', webhookKey: 'sec', fetch })
  await api.notify('k1', 'offline')
  assert.equal(bodies[0].streamKey, 'k1')
  assert.equal(bodies[0].status, 'offline')
  assert.ok(!('hlsUrl' in bodies[0]))
  assert.deepEqual(await api.liveKeys(), ['a', 'b'])
})
