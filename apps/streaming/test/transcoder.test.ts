import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import { Transcoder } from '../src/transcoder.js'

function fakeSpawn() {
  const procs: any[] = []
  const spawn = () => {
    const p: any = new EventEmitter()
    p.stderr = new EventEmitter()
    p.kill = () => {}
    procs.push(p)
    return p
  }
  return { spawn, procs }
}

test("an old FFmpeg's late exit doesn't untrack the new process for the same key", () => {
  const { spawn, procs } = fakeSpawn()
  const t = new Transcoder('ffmpeg', spawn as any)
  const opts = { streamKey: 'k1', rtmpUrl: 'rtmp://x/live/k1', outputDir: path.join(os.tmpdir(), 'tx-k1') }
  t.start(opts)
  t.stop('k1')
  t.start(opts)
  procs[0].emit('exit', 255) // the first process finally exits
  assert.equal(t.isActive('k1'), true)
  procs[1].emit('exit', 0)
  assert.equal(t.isActive('k1'), false)
})
