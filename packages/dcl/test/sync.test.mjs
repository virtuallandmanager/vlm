import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { locationFromSceneJson, sync, install, HUD_ICON_FILE } from '../bin/sync.mjs'

const GC_SCENE = { scene: { base: '-3,-2', parcels: ['-3,-2'] } }

function tmp(sceneJson = GC_SCENE) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'virvi-sync-'))
  if (sceneJson) fs.writeFileSync(path.join(d, 'scene.json'), JSON.stringify(sceneJson))
  return d
}
const model = (n, bytes, extra = {}) => ({
  elementId: 'e' + n, name: 'm' + n, url: `https://cdn.virvi.io/u/${n}.glb`, file: `models/virvi/${n}.glb`, sizeBytes: bytes, ...extra,
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
  assert.deepEqual(r1.downloaded.sort(), ['models/virvi/a.glb', 'models/virvi/b.glb'])
  assert.equal(fs.statSync(path.join(cwd, 'models/virvi/b.glb')).size, 20)
  const mf = JSON.parse(fs.readFileSync(path.join(cwd, 'models/virvi/.virvi-sync.json'), 'utf8'))
  assert.ok(JSON.stringify(mf).includes('models/virvi/a.glb'))
  const f = stub(models)
  const r2 = await run(cwd, f)
  assert.equal(r2.downloaded.length, 0)
  assert.equal(r2.skipped.length, 2)
  assert.equal(f.calls.length, 1)
})

test('re-downloads on size mismatch; null size only if missing', async () => {
  const cwd = tmp()
  await run(cwd, stub([model('a', 10), model('b', null)]))
  fs.writeFileSync(path.join(cwd, 'models/virvi/a.glb'), 'xx')
  fs.writeFileSync(path.join(cwd, 'models/virvi/b.glb'), 'yy')
  const r = await run(cwd, stub([model('a', 10), model('b', null)]))
  assert.deepEqual(r.downloaded, ['models/virvi/a.glb'])
  assert.deepEqual(r.skipped, ['models/virvi/b.glb'])
})

test('removes only manifest-tracked files no longer listed', async () => {
  const cwd = tmp()
  await run(cwd, stub([model('a', 10), model('b', 20)]))
  fs.writeFileSync(path.join(cwd, 'models/virvi/mine.glb'), 'mine')
  const r = await run(cwd, stub([model('a', 10)]))
  assert.deepEqual(r.removed, ['models/virvi/b.glb'])
  assert.ok(!fs.existsSync(path.join(cwd, 'models/virvi/b.glb')))
  assert.ok(fs.existsSync(path.join(cwd, 'models/virvi/mine.glb')))
  assert.ok(fs.existsSync(path.join(cwd, 'models/virvi/a.glb')))
})

test('malicious manifest entries are never deleted', async () => {
  const cwd = tmp()
  fs.mkdirSync(path.join(cwd, 'models/virvi'), { recursive: true })
  fs.writeFileSync(path.join(cwd, 'secret.txt'), 's')
  fs.writeFileSync(path.join(cwd, 'models/virvi/.virvi-sync.json'), JSON.stringify({ files: ['../../secret.txt', 'models/virvi/../../secret.txt', 'scene.json'] }))
  const r = await run(cwd, stub([]))
  assert.deepEqual(r.removed, [])
  assert.ok(fs.existsSync(path.join(cwd, 'secret.txt')))
  assert.ok(fs.existsSync(path.join(cwd, 'scene.json')))
})

test('untrusted server file paths are skipped', async () => {
  const cwd = tmp()
  const bad = [
    model('x', 5, { file: '../evil.glb' }),
    model('y', 5, { file: 'models/virvi/../../evil.glb' }),
    model('z', 5, { file: 'models/virvi/a.txt' }),
    model('w', 5, { file: 'scene.json' }),
    model('v', 5, { url: 'file:///etc/passwd' }),
    model('ok', 5),
  ]
  const warnings = []
  const r = await sync({ cwd, server: 'https://api.test', fetch: stub(bad), log: (m) => warnings.push(m) })
  assert.deepEqual(r.downloaded, ['models/virvi/ok.glb'])
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
  assert.deepEqual(fs.readdirSync(path.join(cwd, 'models/virvi')).filter((n) => n.endsWith('.glb') || n.includes('tmp')), [])
})

test('--dry-run writes nothing', async () => {
  const cwd = tmp()
  const r = await run(cwd, stub([model('a', 10)]), { dryRun: true })
  assert.deepEqual(r.downloaded, ['models/virvi/a.glb'])
  assert.ok(!fs.existsSync(path.join(cwd, 'models')))
})

test('404 not_set_up gives a clear error', async () => {
  await assert.rejects(run(tmp(), stub([], 404)), /isn't set up in Virvi yet — walk into your deployed scene and press Set up Virvi here/)
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
  fs.mkdirSync(path.join(cwd, 'models/virvi'), { recursive: true })
  fs.writeFileSync(path.join(cwd, 'models/virvi/a.glb'), 'mine')
  const logs = []
  const r = await sync({ cwd, server: 'https://api.test', fetch: stub([model('a', 10), model('b', 5)]), log: (m) => logs.push(m) })
  assert.equal(fs.readFileSync(path.join(cwd, 'models/virvi/a.glb'), 'utf8'), 'mine')
  assert.deepEqual(r.downloaded, ['models/virvi/b.glb'])
  assert.ok(logs.some((l) => /wasn't created by virvi-dcl sync/.test(l)))
  const mf = JSON.parse(fs.readFileSync(path.join(cwd, 'models/virvi/.virvi-sync.json'), 'utf8'))
  assert.deepEqual(mf.files, ['models/virvi/b.glb'])
  const r2 = await run(cwd, stub([]))
  assert.deepEqual(r2.removed, ['models/virvi/b.glb'])
  assert.ok(fs.existsSync(path.join(cwd, 'models/virvi/a.glb')))
})

test('case-only rename and duplicates do not delete the downloaded file', async () => {
  const cwd = tmp()
  await run(cwd, stub([model('a', 10)]))
  const up = { ...model('A', 10), url: 'https://cdn.virvi.io/u/A.glb' }
  const r = await run(cwd, stub([up, model('a', 10)]))
  assert.equal(r.removed.length, 0)
  assert.equal(r.downloaded.length + r.skipped.length, 1)
  const names = fs.readdirSync(path.join(cwd, 'models/virvi')).filter((n) => n.endsWith('.glb'))
  assert.ok(names.length >= 1)
})

test('symlinked models/virvi aborts with nothing written outside', async () => {
  const cwd = tmp()
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'virvi-out-'))
  fs.mkdirSync(path.join(cwd, 'models'))
  fs.symlinkSync(outside, path.join(cwd, 'models/virvi'))
  await assert.rejects(run(cwd, stub([model('a', 10)])), /symlink/)
  assert.deepEqual(fs.readdirSync(outside), [])
  const cwd2 = tmp()
  fs.symlinkSync(outside, path.join(cwd2, 'models'))
  await assert.rejects(run(cwd2, stub([model('a', 10)])), /symlink/)
  assert.deepEqual(fs.readdirSync(outside), [])
})

test('stale tmp files removed; oversized download rejected', async () => {
  const cwd = tmp()
  fs.mkdirSync(path.join(cwd, 'models/virvi'), { recursive: true })
  const stale = path.join(cwd, 'models/virvi/a.glb.123e4567-e89b-12d3-a456-426614174000.virvi-tmp')
  fs.writeFileSync(stale, 'x')
  fs.writeFileSync(path.join(cwd, 'models/virvi/keep.tmp'), 'x')
  const f = async (url) =>
    String(url).includes('/api/setup/models')
      ? { ok: true, status: 200, json: async () => ({ models: [model('a', 10)] }) }
      : { ok: true, status: 200, headers: { get: () => String(61 * 1024 * 1024) }, arrayBuffer: async () => new ArrayBuffer(1) }
  const r = await run(cwd, f)
  assert.ok(!fs.existsSync(stale))
  assert.ok(fs.existsSync(path.join(cwd, 'models/virvi/keep.tmp')))
  assert.deepEqual(r.downloaded, [])
  assert.ok(!fs.existsSync(path.join(cwd, 'models/virvi/a.glb')))
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
  fs.mkdirSync(path.join(cwd, 'models/virvi'), { recursive: true })
  const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'virvi-out-')), 'target.json')
  fs.writeFileSync(outside, '{"files":[]}')
  fs.symlinkSync(outside, path.join(cwd, 'models/virvi/.virvi-sync.json'))
  const f = stub([model('a', 10)])
  await assert.rejects(run(cwd, f), /symlink/)
  assert.equal(fs.readFileSync(outside, 'utf8'), '{"files":[]}')
  assert.ok(!fs.existsSync(path.join(cwd, 'models/virvi/a.glb')))
})

test('manifest is written atomically (no tmp files left behind)', async () => {
  const cwd = tmp()
  await run(cwd, stub([model('a', 10)]))
  const names = fs.readdirSync(path.join(cwd, 'models/virvi')).sort()
  assert.deepEqual(names, ['.virvi-sync.json', 'a.glb'])
})

test('a listed file with unsupported name characters gets a re-upload warning', async () => {
  const cwd = tmp()
  const logs = []
  const bad = model('x', 5, { name: 'Fancy', url: 'https://cdn.virvi.io/u/my%20duck.glb', file: 'models/virvi/my duck.glb' })
  const r = await run(cwd, stub([bad, model('a', 10)]), { log: (m) => logs.push(m) })
  assert.deepEqual(r.downloaded, ['models/virvi/a.glb'])
  assert.ok(logs.some((l) => l.includes("can't be synced because its name has unsupported characters — re-upload it")), logs.join('\n'))
  const traversal = model('y', 5, { file: 'models/virvi/../../evil.glb' })
  const logs2 = []
  await run(tmp(), stub([traversal]), { log: (m) => logs2.push(m) })
  assert.ok(logs2.some((l) => l.includes('unsafe or invalid')))
})

const ICON = path.join(import.meta.dirname, '..', 'assets', 'hud-v.png')

test('sync installs the HUD icon at the path the HUD loads, and keeps it current', async () => {
  const cwd = tmp()
  const r = await run(cwd, stub([model('a', 10)]))
  assert.equal(r.icon, 'installed')
  const dest = path.join(cwd, HUD_ICON_FILE)
  assert.ok(fs.readFileSync(dest).equals(fs.readFileSync(ICON)))
  // The HUD (@virvixr/adapter-dcl) textures the launcher from the same scene-relative path
  const hud = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'adapter-dcl', 'src', 'hud', 'icon.ts'), 'utf8')
  assert.ok(hud.includes(`HUD_ICON_SRC = '${HUD_ICON_FILE}'`))
  assert.equal((await run(cwd, stub([model('a', 10)]))).icon, 'unchanged')
  fs.writeFileSync(dest, 'old')
  assert.equal((await run(cwd, stub([model('a', 10)]))).icon, 'installed')
  assert.ok(fs.readFileSync(dest).equals(fs.readFileSync(ICON)))
  assert.deepEqual(fs.readdirSync(path.dirname(dest)), ['hud-v.png'])
})

test('the HUD icon is installed even when the location is not set up; not on --dry-run', async () => {
  const cwd = tmp()
  await assert.rejects(run(cwd, stub([], 404)), /isn't set up/)
  assert.ok(fs.existsSync(path.join(cwd, HUD_ICON_FILE)))
  const dry = tmp()
  const r = await run(dry, stub([model('a', 10)]), { dryRun: true })
  assert.equal(r.icon, 'installed')
  assert.ok(!fs.existsSync(path.join(dry, 'images')))
})

test('the HUD icon is never written through a symlinked images folder', async () => {
  for (const link of ['images', 'images/virvi', HUD_ICON_FILE]) {
    const cwd = tmp()
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'virvi-out-'))
    const parent = path.dirname(path.join(cwd, link))
    fs.mkdirSync(parent, { recursive: true })
    const target = link === HUD_ICON_FILE ? path.join(outside, 'x.png') : outside
    if (link === HUD_ICON_FILE) fs.writeFileSync(target, 'mine')
    fs.symlinkSync(target, path.join(cwd, link))
    await assert.rejects(run(cwd, stub([model('a', 10)])), /symlink/)
    if (link === HUD_ICON_FILE) assert.equal(fs.readFileSync(target, 'utf8'), 'mine')
    else assert.deepEqual(fs.readdirSync(outside), [])
  }
})

test('install: icon always; Creator Hub script only in a Creator Hub project, edits kept unless --force', () => {
  const code = tmp()
  assert.deepEqual(install({ cwd: code, log: () => {} }), { icon: 'installed', script: null })
  assert.ok(fs.existsSync(path.join(code, HUD_ICON_FILE)))
  assert.ok(!fs.existsSync(path.join(code, 'assets')))

  const hub = tmp()
  fs.mkdirSync(path.join(hub, 'assets/scene'), { recursive: true })
  const script = path.join(hub, 'assets/scene/Scripts/VirviManager.ts')
  const pkgScript = fs.readFileSync(path.join(import.meta.dirname, '..', 'creator-hub', 'VirviManager.ts'), 'utf8')
  assert.deepEqual(install({ cwd: hub, log: () => {} }), { icon: 'installed', script: 'installed' })
  assert.equal(fs.readFileSync(script, 'utf8'), pkgScript)
  assert.deepEqual(install({ cwd: hub, log: () => {} }), { icon: 'unchanged', script: 'unchanged' })
  fs.writeFileSync(script, '// edited')
  const logs = []
  assert.equal(install({ cwd: hub, log: (m) => logs.push(m) }).script, 'differs')
  assert.equal(fs.readFileSync(script, 'utf8'), '// edited')
  assert.ok(logs.some((l) => l.includes('--force')))
  assert.equal(install({ cwd: hub, force: true, log: () => {} }).script, 'installed')
  assert.equal(fs.readFileSync(script, 'utf8'), pkgScript)

  const dry = tmp()
  fs.mkdirSync(path.join(dry, 'assets/scene'), { recursive: true })
  install({ cwd: dry, dryRun: true, log: () => {} })
  assert.ok(!fs.existsSync(path.join(dry, 'images')))
  assert.ok(!fs.existsSync(path.join(dry, 'assets/scene/Scripts')))
  assert.throws(() => install({ cwd: tmp(null), log: () => {} }), /scene\.json/)
})
