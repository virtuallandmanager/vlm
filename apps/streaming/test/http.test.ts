import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHttpHandler } from '../src/http.js'

async function serve(outputDir: string) {
  const server = createServer(createHttpHandler({ outputDir, activeCount: () => 2 }))
  await new Promise<void>((r) => server.listen(0, r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { base, close: () => new Promise<void>((r) => server.close(() => r())) }
}

test('health reports a count, never stream keys; /status is gone', async () => {
  const { base, close } = await serve(fs.mkdtempSync(path.join(os.tmpdir(), 'hls-')))
  try {
    const health = await (await fetch(`${base}/health`)).json()
    assert.equal(health.status, 'ok')
    assert.equal(health.activeStreams, 2)
    assert.equal((await fetch(`${base}/status`)).status, 404)
  } finally {
    await close()
  }
})

test('serves a playlist with CORS and no-cache; traversal and unknown files 404', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hls-'))
  fs.mkdirSync(path.join(dir, 'pb1'))
  fs.writeFileSync(path.join(dir, 'pb1', 'playlist.m3u8'), '#EXTM3U\n')
  fs.writeFileSync(path.join(dir, 'secret.m3u8'), 'nope')
  const { base, close } = await serve(dir)
  try {
    const res = await fetch(`${base}/streams/pb1/playlist.m3u8`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'application/vnd.apple.mpegurl')
    assert.equal(res.headers.get('access-control-allow-origin'), '*')
    assert.equal(res.headers.get('cache-control'), 'no-cache')
    assert.equal(await res.text(), '#EXTM3U\n')
    assert.equal((await fetch(`${base}/streams/pb1/missing.ts`)).status, 404)
    assert.equal((await fetch(`${base}/streams/%2e%2e/secret.m3u8`)).status, 404)
  } finally {
    await close()
  }
})
