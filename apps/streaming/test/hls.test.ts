// apps/streaming/test/hls.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { resolveHlsPath } from '../src/hls.js'

const OUT = path.resolve('/data/streams')

test('resolves playlist and segments inside the output dir', () => {
  assert.equal(resolveHlsPath(OUT, '/streams/k1/playlist.m3u8'), path.join(OUT, 'k1/playlist.m3u8'))
  assert.equal(resolveHlsPath(OUT, '/streams/k1/seg_001.ts?x=1'), path.join(OUT, 'k1/seg_001.ts'))
})

test('rejects traversal, encoded traversal, other prefixes and other extensions', () => {
  for (const u of ['/streams/../secret.m3u8', '/streams/%2e%2e/secret.m3u8', '/streams/k1/../../etc/x.ts', '/other/k1/playlist.m3u8', '/streams/k1/notes.txt', '/streams/%E0%A4%A']) {
    assert.equal(resolveHlsPath(OUT, u), null, u)
  }
})

import fs from 'node:fs'
import os from 'node:os'
import { waitForFile } from '../src/hls.js'

test('waitForFile resolves true once the file appears, false after the timeout', async () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-')), 'playlist.m3u8')
  setTimeout(() => fs.writeFileSync(f, '#EXTM3U'), 30)
  assert.equal(await waitForFile(f, { timeoutMs: 1000, intervalMs: 10 }), true)
  assert.equal(await waitForFile(f + '.nope', { timeoutMs: 40, intervalMs: 10 }), false)
})
