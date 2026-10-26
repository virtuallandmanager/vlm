import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { replayTarget, createRouter } from './server.mjs'

const D = 'worlds.virvi.io'

test('valid slug host maps to vlm-w-<slug>', () => {
  assert.equal(replayTarget('my-world.worlds.virvi.io', D), 'vlm-w-my-world')
  assert.equal(replayTarget('abc.worlds.virvi.io', D), 'vlm-w-abc')
  assert.equal(replayTarget('My-World9.Worlds.VIRVI.io:443', D), 'vlm-w-my-world9')
  assert.equal(replayTarget('a'.repeat(30) + '.worlds.virvi.io', D), 'vlm-w-' + 'a'.repeat(30))
})

test('apex, nested subdomain, bad characters, other domains → null', () => {
  for (const h of [
    'worlds.virvi.io', 'a.b.worlds.virvi.io', 'ab.worlds.virvi.io', 'a'.repeat(31) + '.worlds.virvi.io',
    'my_world.worlds.virvi.io', 'my world.worlds.virvi.io', 'x.example.com', 'abc.worlds.virvi.io.evil.com',
    'abc-worlds.virvi.io', '-abc.worlds.virvi.io', 'abc-.worlds.virvi.io', '', undefined,
  ]) assert.equal(replayTarget(h, D), null, String(h))
  assert.equal(replayTarget('abc.other.test', 'other.test'), 'vlm-w-abc')
})

async function start(opts) {
  const server = createRouter(D, opts)
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
    const out = await raw(server, 'POST / HTTP/1.1\r\nHost: foo-bar.worlds.virvi.io\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    assert.match(out, /^HTTP\/1\.1 307/)
    assert.match(out, /fly-replay: app=vlm-w-foo-bar\r\n/i)
  } finally { server.close() }
})

test('a WebSocket upgrade request gets the replay header without being upgraded', async () => {
  const server = await start()
  try {
    const out = await raw(server, 'GET /ws HTTP/1.1\r\nHost: foo-bar.worlds.virvi.io:443\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n')
    assert.match(out, /^HTTP\/1\.1 307 Temporary Redirect\r\n/)
    assert.match(out, /fly-replay: app=vlm-w-foo-bar\r\n/)
    assert.match(out, /content-length: 0/)
    assert.doesNotMatch(out, /101/)
  } finally { server.close() }
})

test('unknown host gets a 404 page, for HTTP and upgrades', async () => {
  const server = await start()
  try {
    const out = await raw(server, 'GET /nope HTTP/1.1\r\nHost: a.b.worlds.virvi.io\r\nConnection: close\r\n\r\n')
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
    const w = await raw(server, 'GET /healthz HTTP/1.1\r\nHost: foo.worlds.virvi.io\r\nConnection: close\r\n\r\n')
    assert.match(w, /^HTTP\/1\.1 307/)
    const h = await raw(server, 'GET /healthz HTTP/1.1\r\nHost: \r\nConnection: close\r\n\r\n')
    assert.match(h, /^HTTP\/1\.1 200/)
  } finally { server.close() }
})

async function upstream() {
  const seen = []
  const up = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, host: req.headers.host, body: Buffer.concat(chunks) })
      res.writeHead(201, { 'x-up': 'yes', 'content-type': 'text/plain' })
      res.end('from upstream')
    })
  })
  await new Promise((r) => up.listen(0, '127.0.0.1', r))
  return { up, seen, port: up.address().port }
}

function post(server, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port: server.address().port, host: '127.0.0.1', method: 'POST', path: '/upload?x=1', headers: { host: 'foo-bar.worlds.virvi.io', ...headers } }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('error', reject)
      res.on('end', () => resolve({ res, body: Buffer.concat(chunks).toString() }))
    })
    req.on('error', reject)
    body(req)
  })
}

test('a 2 MB POST to a world host is proxied to the upstream with the exact bytes', async () => {
  const { up, seen, port } = await upstream()
  const server = await start({ upstreamHost: () => '127.0.0.1', upstreamPort: port })
  try {
    const data = randomBytes(2 * 1024 * 1024)
    const { res, body } = await post(server, { 'content-length': data.length }, (req) => req.end(data))
    assert.equal(res.statusCode, 201)
    assert.equal(res.headers['x-up'], 'yes')
    assert.equal(body, 'from upstream')
    assert.equal(seen.length, 1)
    assert.equal(seen[0].url, '/upload?x=1')
    assert.equal(seen[0].host, 'foo-bar.worlds.virvi.io')
    assert.ok(seen[0].body.equals(data))
  } finally { server.close(); up.close() }
})

test('a chunked POST to a world host is proxied', async () => {
  const { up, seen, port } = await upstream()
  const server = await start({ upstreamHost: () => '127.0.0.1', upstreamPort: port })
  try {
    const { res } = await post(server, {}, (req) => { req.write('hello '); req.end('world') })
    assert.equal(res.statusCode, 201)
    assert.equal(seen[0].body.toString(), 'hello world')
  } finally { server.close(); up.close() }
})

test('a POST of exactly 1 MB still gets the 307 replay', async () => {
  const { up, seen, port } = await upstream()
  const server = await start({ upstreamHost: () => '127.0.0.1', upstreamPort: port })
  try {
    const data = Buffer.alloc(1048576, 1)
    const { res } = await post(server, { 'content-length': data.length }, (req) => req.end(data))
    assert.equal(res.statusCode, 307)
    assert.equal(res.headers['fly-replay'], 'app=vlm-w-foo-bar')
    assert.equal(seen.length, 0)
  } finally { server.close(); up.close() }
})

test('an unreachable upstream gives a short 502', async () => {
  const dead = http.createServer()
  await new Promise((r) => dead.listen(0, '127.0.0.1', r))
  const port = dead.address().port
  await new Promise((r) => dead.close(r))
  const server = await start({ upstreamHost: () => '127.0.0.1', upstreamPort: port })
  try {
    const data = Buffer.alloc(1048577, 1)
    const { res, body } = await post(server, { 'content-length': data.length }, (req) => req.end(data))
    assert.equal(res.statusCode, 502)
    assert.ok(body.length < 100)
    assert.doesNotMatch(body, /ECONNREFUSED|at /)
  } finally { server.close() }
})

test('an upstream that dies after sending headers closes the client connection', async () => {
  const up = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-length': 1000 })
      res.write('partial')
      setTimeout(() => res.socket.destroy(), 50)
    })
  })
  await new Promise((r) => up.listen(0, '127.0.0.1', r))
  const server = await start({ upstreamHost: () => '127.0.0.1', upstreamPort: up.address().port })
  try {
    const data = Buffer.alloc(1048577, 1)
    const outcome = await Promise.race([
      post(server, { 'content-length': data.length }, (req) => req.end(data)).then(() => 'ended', () => 'closed'),
      new Promise((r) => setTimeout(() => r('hung'), 2000)),
    ])
    assert.notEqual(outcome, 'hung')
  } finally { server.closeAllConnections(); server.close(); up.close() }
})

test('hop-by-hop headers are stripped in both directions, Host is kept', async () => {
  let got
  const up = http.createServer((req, res) => {
    got = req.headers
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { connection: 'x-secret-hop, keep-alive', 'x-secret-hop': '1', 'keep-alive': 'timeout=5', 'x-keep': 'yes' })
      res.end('ok')
    })
  })
  await new Promise((r) => up.listen(0, '127.0.0.1', r))
  const server = await start({ upstreamHost: () => '127.0.0.1', upstreamPort: up.address().port })
  try {
    const data = Buffer.alloc(1048577, 1)
    const { res } = await post(server, { 'content-length': data.length, connection: 'x-req-hop, close', 'x-req-hop': '1', 'proxy-authorization': 'secret', te: 'trailers', 'x-keep': 'yes' }, (req) => req.end(data))
    assert.equal(got['x-req-hop'], undefined)
    assert.equal(got['proxy-authorization'], undefined)
    assert.equal(got.te, undefined)
    assert.equal(got['x-keep'], 'yes')
    assert.equal(got.host, 'foo-bar.worlds.virvi.io')
    assert.equal(res.headers['x-secret-hop'], undefined)
    assert.equal(res.headers['keep-alive'], undefined)
    assert.equal(res.headers['x-keep'], 'yes')
  } finally { server.closeAllConnections(); server.close(); up.close() }
})
