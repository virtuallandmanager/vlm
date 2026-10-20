import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { replayTarget, createRouter } from './server.mjs'

const D = 'worlds.vlm.gg'

test('valid slug host maps to vlm-w-<slug>', () => {
  assert.equal(replayTarget('my-world.worlds.vlm.gg', D), 'vlm-w-my-world')
  assert.equal(replayTarget('abc.worlds.vlm.gg', D), 'vlm-w-abc')
  assert.equal(replayTarget('My-World9.Worlds.VLM.gg:443', D), 'vlm-w-my-world9')
  assert.equal(replayTarget('a'.repeat(30) + '.worlds.vlm.gg', D), 'vlm-w-' + 'a'.repeat(30))
})

test('apex, nested subdomain, bad characters, other domains → null', () => {
  for (const h of [
    'worlds.vlm.gg', 'a.b.worlds.vlm.gg', 'ab.worlds.vlm.gg', 'a'.repeat(31) + '.worlds.vlm.gg',
    'my_world.worlds.vlm.gg', 'my world.worlds.vlm.gg', 'x.example.com', 'abc.worlds.vlm.gg.evil.com',
    'abc-worlds.vlm.gg', '', undefined,
  ]) assert.equal(replayTarget(h, D), null, String(h))
  assert.equal(replayTarget('abc.other.test', 'other.test'), 'vlm-w-abc')
})

async function start() {
  const server = createRouter(D)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return server
}

function raw(server, request) {
  return new Promise((resolve) => {
    const s = net.connect(server.address().port, '127.0.0.1', () => s.write(request))
    let out = ''
    s.on('data', (d) => (out += d))
    s.on('close', () => resolve(out))
  })
}

test('plain request gets an empty 307 with the replay header', async () => {
  const server = await start()
  try {
    const out = await raw(server, 'POST / HTTP/1.1\r\nHost: foo-bar.worlds.vlm.gg\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    assert.match(out, /^HTTP\/1\.1 307/)
    assert.match(out, /fly-replay: app=vlm-w-foo-bar\r\n/i)
  } finally { server.close() }
})

test('a WebSocket upgrade request gets the replay header without being upgraded', async () => {
  const server = await start()
  try {
    const out = await raw(server, 'GET /ws HTTP/1.1\r\nHost: foo-bar.worlds.vlm.gg:443\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n')
    assert.match(out, /^HTTP\/1\.1 307 Temporary Redirect\r\n/)
    assert.match(out, /fly-replay: app=vlm-w-foo-bar\r\n/)
    assert.match(out, /content-length: 0/)
    assert.doesNotMatch(out, /101/)
  } finally { server.close() }
})

test('unknown host gets a 404 page, for HTTP and upgrades', async () => {
  const server = await start()
  try {
    const out = await raw(server, 'GET /nope HTTP/1.1\r\nHost: a.b.worlds.vlm.gg\r\nConnection: close\r\n\r\n')
    assert.match(out, /^HTTP\/1\.1 404/)
    assert.match(out, /No world here/)
    assert.doesNotMatch(out, /fly-replay/i)
    const up = await raw(server, 'GET /ws HTTP/1.1\r\nHost: nope.example.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
    assert.match(up, /^HTTP\/1\.1 404 Not Found\r\n/)
    assert.match(up, /No world here/)
  } finally { server.close() }
})

test('GET /healthz on a non-world host answers 200 ok; a world host is still replayed', async () => {
  const server = await start()
  try {
    const out = await raw(server, 'GET /healthz HTTP/1.1\r\nHost: vlm-worlds-router.fly.dev\r\nConnection: close\r\n\r\n')
    assert.match(out, /^HTTP\/1\.1 200/)
    assert.match(out, /\r\n\r\nok$/)
    const w = await raw(server, 'GET /healthz HTTP/1.1\r\nHost: foo.worlds.vlm.gg\r\nConnection: close\r\n\r\n')
    assert.match(w, /^HTTP\/1\.1 307/)
    const h = await raw(server, 'GET /healthz HTTP/1.1\r\nHost: \r\nConnection: close\r\n\r\n')
    assert.match(h, /^HTTP\/1\.1 200/)
  } finally { server.close() }
})
