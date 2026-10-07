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
