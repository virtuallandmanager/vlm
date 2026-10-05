import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { locationFromSceneJson, sync } from '../bin/sync.mjs'

const GC_SCENE = { scene: { base: '-3,-2', parcels: ['-3,-2'] } }

function tmp(sceneJson = GC_SCENE) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vlm-sync-'))
  if (sceneJson) fs.writeFileSync(path.join(d, 'scene.json'), JSON.stringify(sceneJson))
  return d
}
const model = (n, bytes, extra = {}) => ({
  elementId: 'e' + n, name: 'm' + n, url: `https://cdn.vlm.gg/u/${n}.glb`, file: `models/vlm/${n}.glb`, sizeBytes: bytes, ...extra,
})
function stub(models, status = 200, body) {
  const calls = []
  const fn = async (url) => {
    calls.push(String(url))
    if (String(url).includes('/api/setup/models')) {
      return { ok: status === 200, status, json: async () => body ?? (status === 200 ? { sceneId: 's', models } : { error: 'not_set_up' }) }
    }
    const m = /\/([^/]+)\.glb$/.exec(String(url))
    const buf = Buffer.alloc(models.find((x) => x.url === String(url))?.sizeBytes ?? 3, m ? m[1] : 'x')
    return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) }
  }
  fn.calls = calls
  return fn
}
const run = (cwd, fetch, extra = {}) => sync({ cwd, server: 'https://api.test', fetch, log: () => {}, ...extra })

test('locationFromSceneJson', () => {
  assert.equal(locationFromSceneJson({ scene: { base: '-3,-2' } }), 'gc:-3,-2')
  assert.equal(locationFromSceneJson({ scene: { base: '0,0' }, worldConfiguration: { name: 'My.DCL.eth' } }), 'world:my.dcl.eth')
  assert.throws(() => locationFromSceneJson({}))
})

test('downloads, writes manifest, second run skips', async () => {
  const cwd = tmp()
  const models = [model('a', 10), model('b', 20)]
  const r1 = await run(cwd, stub(models))
  assert.deepEqual(r1.downloaded.sort(), ['models/vlm/a.glb', 'models/vlm/b.glb'])
  assert.equal(fs.statSync(path.join(cwd, 'models/vlm/b.glb')).size, 20)
  const mf = JSON.parse(fs.readFileSync(path.join(cwd, 'models/vlm/.vlm-sync.json'), 'utf8'))
  assert.ok(JSON.stringify(mf).includes('models/vlm/a.glb'))
  const f = stub(models)
  const r2 = await run(cwd, f)
  assert.equal(r2.downloaded.length, 0)
  assert.equal(r2.skipped.length, 2)
  assert.equal(f.calls.length, 1)
})

test('re-downloads on size mismatch; null size only if missing', async () => {
  const cwd = tmp()
  await run(cwd, stub([model('a', 10), model('b', null)]))
  fs.writeFileSync(path.join(cwd, 'models/vlm/a.glb'), 'xx')
  fs.writeFileSync(path.join(cwd, 'models/vlm/b.glb'), 'yy')
  const r = await run(cwd, stub([model('a', 10), model('b', null)]))
  assert.deepEqual(r.downloaded, ['models/vlm/a.glb'])
  assert.deepEqual(r.skipped, ['models/vlm/b.glb'])
})

test('removes only manifest-tracked files no longer listed', async () => {
  const cwd = tmp()
  await run(cwd, stub([model('a', 10), model('b', 20)]))
  fs.writeFileSync(path.join(cwd, 'models/vlm/mine.glb'), 'mine')
  const r = await run(cwd, stub([model('a', 10)]))
  assert.deepEqual(r.removed, ['models/vlm/b.glb'])
  assert.ok(!fs.existsSync(path.join(cwd, 'models/vlm/b.glb')))
  assert.ok(fs.existsSync(path.join(cwd, 'models/vlm/mine.glb')))
  assert.ok(fs.existsSync(path.join(cwd, 'models/vlm/a.glb')))
})

test('malicious manifest entries are never deleted', async () => {
  const cwd = tmp()
  fs.mkdirSync(path.join(cwd, 'models/vlm'), { recursive: true })
  fs.writeFileSync(path.join(cwd, 'secret.txt'), 's')
  fs.writeFileSync(path.join(cwd, 'models/vlm/.vlm-sync.json'), JSON.stringify({ files: ['../../secret.txt', 'models/vlm/../../secret.txt', 'scene.json'] }))
  const r = await run(cwd, stub([]))
  assert.deepEqual(r.removed, [])
  assert.ok(fs.existsSync(path.join(cwd, 'secret.txt')))
  assert.ok(fs.existsSync(path.join(cwd, 'scene.json')))
})

test('untrusted server file paths are skipped', async () => {
  const cwd = tmp()
  const bad = [
    model('x', 5, { file: '../evil.glb' }),
    model('y', 5, { file: 'models/vlm/../../evil.glb' }),
    model('z', 5, { file: 'models/vlm/a.txt' }),
    model('w', 5, { file: 'scene.json' }),
    model('v', 5, { url: 'file:///etc/passwd' }),
    model('ok', 5),
  ]
  const warnings = []
  const r = await sync({ cwd, server: 'https://api.test', fetch: stub(bad), log: (m) => warnings.push(m) })
  assert.deepEqual(r.downloaded, ['models/vlm/ok.glb'])
  assert.ok(!fs.existsSync(path.join(cwd, '..', 'evil.glb')))
  assert.ok(JSON.parse(fs.readFileSync(path.join(cwd, 'scene.json'), 'utf8')).scene)
  assert.ok(warnings.some((w) => /skip/i.test(w)))
})

test('failed download leaves no partial file', async () => {
  const cwd = tmp()
  const f = async (url) =>
    String(url).includes('/api/setup/models')
      ? { ok: true, status: 200, json: async () => ({ sceneId: 's', models: [model('a', 10)] }) }
      : { ok: false, status: 500 }
  const r = await run(cwd, f)
  assert.deepEqual(r.downloaded, [])
  assert.deepEqual(fs.readdirSync(path.join(cwd, 'models/vlm')).filter((n) => n.endsWith('.glb') || n.includes('tmp')), [])
})

test('--dry-run writes nothing', async () => {
  const cwd = tmp()
  const r = await run(cwd, stub([model('a', 10)]), { dryRun: true })
  assert.deepEqual(r.downloaded, ['models/vlm/a.glb'])
  assert.ok(!fs.existsSync(path.join(cwd, 'models')))
})

test('404 not_set_up gives a clear error', async () => {
  await assert.rejects(run(tmp(), stub([], 404)), /isn't set up in VLM yet — walk into your deployed scene and press Set up VLM here/)
})

test('400 / 429 errors', async () => {
  await assert.rejects(run(tmp(), stub([], 400, { error: 'invalid_location' })), /invalid/i)
  await assert.rejects(run(tmp(), stub([], 429, {})), /rate/i)
})

test('size over limit: GC 1 parcel with 16 MB', async () => {
  const cwd = tmp()
  fs.mkdirSync(path.join(cwd, 'node_modules'))
  fs.writeFileSync(path.join(cwd, 'node_modules/big'), Buffer.alloc(50 * 1024 * 1024))
  fs.writeFileSync(path.join(cwd, 'big.bin'), Buffer.alloc(16 * 1024 * 1024))
  const r = await run(cwd, stub([]))
  assert.equal(r.over, true)
  assert.equal(r.limitBytes, 15 * 1024 * 1024)
  assert.ok(r.totalBytes >= 16 * 1024 * 1024 && r.totalBytes < 17 * 1024 * 1024)
})

test('world limit is 100 MB and under limit is not over', async () => {
  const cwd = tmp({ scene: { base: '0,0', parcels: ['0,0'] }, worldConfiguration: { name: 'w.dcl.eth' } })
  const f = stub([])
  const r = await run(cwd, f)
  assert.equal(r.limitBytes, 100 * 1024 * 1024)
  assert.equal(r.over, false)
  assert.match(f.calls[0], /location=world%3Aw\.dcl\.eth|location=world:w\.dcl\.eth/)
})

test('untracked existing file is never overwritten or tracked', async () => {
  const cwd = tmp()
  fs.mkdirSync(path.join(cwd, 'models/vlm'), { recursive: true })
  fs.writeFileSync(path.join(cwd, 'models/vlm/a.glb'), 'mine')
  const logs = []
  const r = await sync({ cwd, server: 'https://api.test', fetch: stub([model('a', 10), model('b', 5)]), log: (m) => logs.push(m) })
  assert.equal(fs.readFileSync(path.join(cwd, 'models/vlm/a.glb'), 'utf8'), 'mine')
  assert.deepEqual(r.downloaded, ['models/vlm/b.glb'])
  assert.ok(logs.some((l) => /wasn't created by vlm-dcl sync/.test(l)))
  const mf = JSON.parse(fs.readFileSync(path.join(cwd, 'models/vlm/.vlm-sync.json'), 'utf8'))
  assert.deepEqual(mf.files, ['models/vlm/b.glb'])
  const r2 = await run(cwd, stub([]))
  assert.deepEqual(r2.removed, ['models/vlm/b.glb'])
  assert.ok(fs.existsSync(path.join(cwd, 'models/vlm/a.glb')))
})

test('case-only rename and duplicates do not delete the downloaded file', async () => {
  const cwd = tmp()
  await run(cwd, stub([model('a', 10)]))
  const up = { ...model('A', 10), url: 'https://cdn.vlm.gg/u/A.glb' }
  const r = await run(cwd, stub([up, model('a', 10)]))
  assert.equal(r.removed.length, 0)
  assert.equal(r.downloaded.length + r.skipped.length, 1)
  const names = fs.readdirSync(path.join(cwd, 'models/vlm')).filter((n) => n.endsWith('.glb'))
  assert.ok(names.length >= 1)
})

test('symlinked models/vlm aborts with nothing written outside', async () => {
  const cwd = tmp()
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'vlm-out-'))
  fs.mkdirSync(path.join(cwd, 'models'))
  fs.symlinkSync(outside, path.join(cwd, 'models/vlm'))
  await assert.rejects(run(cwd, stub([model('a', 10)])), /symlink/)
  assert.deepEqual(fs.readdirSync(outside), [])
  const cwd2 = tmp()
  fs.symlinkSync(outside, path.join(cwd2, 'models'))
  await assert.rejects(run(cwd2, stub([model('a', 10)])), /symlink/)
  assert.deepEqual(fs.readdirSync(outside), [])
})

test('stale tmp files removed; oversized download rejected', async () => {
  const cwd = tmp()
  fs.mkdirSync(path.join(cwd, 'models/vlm'), { recursive: true })
  const stale = path.join(cwd, 'models/vlm/a.glb.123e4567-e89b-12d3-a456-426614174000.vlm-tmp')
  fs.writeFileSync(stale, 'x')
  fs.writeFileSync(path.join(cwd, 'models/vlm/keep.tmp'), 'x')
  const f = async (url) =>
    String(url).includes('/api/setup/models')
      ? { ok: true, status: 200, json: async () => ({ models: [model('a', 10)] }) }
      : { ok: true, status: 200, headers: { get: () => String(61 * 1024 * 1024) }, arrayBuffer: async () => new ArrayBuffer(1) }
  const r = await run(cwd, f)
  assert.ok(!fs.existsSync(stale))
  assert.ok(fs.existsSync(path.join(cwd, 'models/vlm/keep.tmp')))
  assert.deepEqual(r.downloaded, [])
  assert.ok(!fs.existsSync(path.join(cwd, 'models/vlm/a.glb')))
})

test('model-list fetch passes an abort signal and times out with a clear error', async () => {
  const cwd = tmp()
  let signal
  const hanging = async (_url, opts) => {
    signal = opts?.signal
    // AbortSignal.timeout's timer is unref'd: keep the loop alive until it fires
    const keepAlive = setTimeout(() => {}, 5000)
    return new Promise((_, reject) => opts.signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(opts.signal.reason) }))
  }
  await assert.rejects(run(cwd, hanging, { listTimeoutMs: 50 }), /didn't answer within/)
  assert.ok(signal instanceof AbortSignal)
})

test('a symlinked manifest is refused and left untouched', async () => {
  const cwd = tmp()
  fs.mkdirSync(path.join(cwd, 'models/vlm'), { recursive: true })
  const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vlm-out-')), 'target.json')
  fs.writeFileSync(outside, '{"files":[]}')
  fs.symlinkSync(outside, path.join(cwd, 'models/vlm/.vlm-sync.json'))
  const f = stub([model('a', 10)])
  await assert.rejects(run(cwd, f), /symlink/)
  assert.equal(fs.readFileSync(outside, 'utf8'), '{"files":[]}')
  assert.ok(!fs.existsSync(path.join(cwd, 'models/vlm/a.glb')))
})

test('manifest is written atomically (no tmp files left behind)', async () => {
  const cwd = tmp()
  await run(cwd, stub([model('a', 10)]))
  const names = fs.readdirSync(path.join(cwd, 'models/vlm')).sort()
  assert.deepEqual(names, ['.vlm-sync.json', 'a.glb'])
})

test('a listed file with unsupported name characters gets a re-upload warning', async () => {
  const cwd = tmp()
  const logs = []
  const bad = model('x', 5, { name: 'Fancy', url: 'https://cdn.vlm.gg/u/my%20duck.glb', file: 'models/vlm/my duck.glb' })
  const r = await run(cwd, stub([bad, model('a', 10)]), { log: (m) => logs.push(m) })
  assert.deepEqual(r.downloaded, ['models/vlm/a.glb'])
  assert.ok(logs.some((l) => l.includes("can't be synced because its name has unsupported characters — re-upload it")), logs.join('\n'))
  const traversal = model('y', 5, { file: 'models/vlm/../../evil.glb' })
  const logs2 = []
  await run(tmp(), stub([traversal]), { log: (m) => logs2.push(m) })
  assert.ok(logs2.some((l) => l.includes('unsafe or invalid')))
})
