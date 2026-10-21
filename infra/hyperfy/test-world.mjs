// World test for VLM's Hyperfy image: boots a built, patched Hyperfy source tree locally and checks that the VLM app
// is installed as blueprint `vlm` (one entity at the origin) beside Hyperfy's default `$scene`, and that only the server
// half of the shipped VLM script can vouch with VLM (`app.vlmVouch`, patch 0003), and the world secret stays in Node.
//
//   node infra/hyperfy/test-world.mjs <hyperfy-src-dir>
//
// The source dir is Hyperfy at b4081eb with infra/hyperfy/patches applied and `npm run build` done. Run with the Node
// that built it (Node 22). Needs `sqlite3`, Google Chrome (headless, DevTools on port 9333) and the local Postgres
// (TEST_DATABASE_URL, default as in apps/server/vitest.config.ts) for the restricted-role boot.
import { spawn, execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, rmSync, mkdtempSync, existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomBytes, createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const srcDir = path.resolve(process.argv[2] || '')
if (!process.argv[2] || !existsSync(path.join(srcDir, 'build/index.js'))) {
  console.error('usage: node infra/hyperfy/test-world.mjs <built hyperfy src dir>')
  process.exit(2)
}
const hypPath = path.join(repoRoot, 'packages/vlm-hyperfy-app/dist/vlm.hyp')
const PORT = 3211
const base = `http://localhost:${PORT}`
const FEED_URL = 'http://127.0.0.1:9/vlm-feed'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function readHyp(file) {
  const buf = readFileSync(file)
  const n = buf.readUInt32LE(0)
  const header = JSON.parse(buf.subarray(4, 4 + n))
  let off = 4 + n
  const files = header.assets.map((a) => {
    const bytes = buf.subarray(off, off + a.size)
    off += a.size
    return { name: a.url.replace('asset://', ''), bytes }
  })
  return { header, blueprint: header.blueprint, files }
}
function writeHyp(file, blueprint, assets) {
  const header = Buffer.from(JSON.stringify({ blueprint, assets: assets.map(({ bytes, ...a }) => ({ ...a, size: bytes.length })) }))
  const size = Buffer.alloc(4)
  size.writeUInt32LE(header.length)
  writeFileSync(file, Buffer.concat([size, header, ...assets.map((a) => a.bytes)]))
}
const scriptAsset = (code) => {
  const bytes = Buffer.from(code)
  return { type: 'script', url: `asset://${createHash('sha256').update(bytes).digest('hex')}.js`, mime: 'application/javascript', bytes }
}
const vlmHyp = readHyp(hypPath)
const sceneHyp = readHyp(path.join(srcDir, 'src/world/scene.hyp'))

// --- world process -------------------------------------------------------------------------------------------------

let child
let log = []
async function boot(world, env) {
  log = []
  child = spawn(process.execPath, ['build/index.js'], {
    cwd: srcDir,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      WORLD: world,
      PORT: String(PORT),
      JWT_SECRET: randomBytes(24).toString('hex'),
      ADMIN_CODE: '',
      SAVE_INTERVAL: '60',
      PUBLIC_MAX_UPLOAD_SIZE: '12',
      PUBLIC_WS_URL: `ws://localhost:${PORT}/ws`,
      PUBLIC_API_URL: `${base}/api`,
      ASSETS: 'local',
      ASSETS_BASE_URL: `${base}/assets`,
      DB_URI: 'local',
      VLM_APP_PATH: hypPath,
      VLM_FEED_URL: FEED_URL,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => log.push(String(d)))
  child.stderr.on('data', (d) => log.push(String(d)))
  const exited = new Promise((r) => child.once('exit', (code) => r(code)))
  for (let i = 0; i < 120; i++) {
    const code = await Promise.race([exited, wait(500).then(() => undefined)])
    if (code !== undefined) throw new Error(`world exited (${code}) during boot:\n${log.join('').slice(-3000)}`)
    try {
      if ((await fetch(`${base}/status`)).ok) return
    } catch {}
  }
  throw new Error(`world did not answer /status within 60 s:\n${log.join('').slice(-3000)}`)
}

async function stop() {
  if (!child || child.exitCode !== null) return
  const exited = new Promise((r) => child.once('exit', r))
  child.kill('SIGTERM')
  await Promise.race([exited, wait(5000)])
  if (child.exitCode === null) child.kill('SIGKILL')
}

// --- sqlite --------------------------------------------------------------------------------------------------------

const sqlite = (world, sql) =>
  JSON.parse(execFileSync('sqlite3', ['-json', path.join(srcDir, world, 'db.sqlite'), sql]).toString() || '[]')
const esc = (s) => s.replace(/'/g, "''")
const rowsOf = (rows) => rows.map((r) => ({ ...r, data: JSON.parse(r.data) }))

// --- headless Chrome probe (as in project 1's probe.mjs) ------------------------------------------------------------

async function probe(url, expression, settleMs = 20000) {
  const profile = mkdtempSync(path.join(tmpdir(), 'vlm-world-test-chrome-'))
  const chrome = spawn(
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=9333', '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader', '--window-size=1280,720', 'about:blank'],
    { stdio: 'ignore' },
  )
  try {
    let tab
    for (let i = 0; i < 40 && !tab; i++) {
      await wait(250)
      try { tab = await (await fetch('http://127.0.0.1:9333/json/new?about:blank', { method: 'PUT' })).json() } catch {}
    }
    if (!tab) throw new Error('headless Chrome did not open DevTools on 9333')
    const ws = new WebSocket(tab.webSocketDebuggerUrl)
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
    let id = 0
    const pending = new Map()
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
    const call = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
    await call('Page.navigate', { url })
    let value
    for (let t = 0; t < settleMs; t += 1000) {
      await wait(1000)
      const res = await call('Runtime.evaluate', { expression, returnByValue: true })
      value = res.result?.result?.value
      if (value && value.ready) break
    }
    ws.close()
    return value
  } finally {
    chrome.kill('SIGKILL')
    await wait(300)
    rmSync(profile, { recursive: true, force: true })
  }
}

const inspectWorld = `(() => {
  const w = window.world
  if (!w || !w.blueprints || !w.entities) return { ready: false }
  const apps = [...w.entities.items.values()].filter((e) => e.data?.type === 'app')
  const vlm = w.blueprints.get('vlm')
  const scene = w.blueprints.get('$scene')
  return {
    ready: !!vlm && !!scene && apps.length > 0,
    vlmProps: vlm?.props ?? null,
    sceneModel: scene?.model ?? null,
    vlmEntities: apps.filter((e) => e.data.blueprint === 'vlm').map((e) => e.data.position),
  }
})()`

// A Chrome session on the world that records the page's console and every WebSocket frame it receives; `fn` gets
// `evaluate(expression)` (awaits promises) and `waitFor(expression)` (until it returns a truthy value).
async function session(url, fn) {
  const profile = mkdtempSync(path.join(tmpdir(), 'vlm-world-test-chrome-'))
  const chrome = spawn(
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=9333', '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader', '--window-size=1280,720', 'about:blank'],
    { stdio: 'ignore' },
  )
  const consoles = []
  const frames = []
  try {
    let tab
    for (let i = 0; i < 40 && !tab; i++) {
      await wait(250)
      try { tab = await (await fetch('http://127.0.0.1:9333/json/new?about:blank', { method: 'PUT' })).json() } catch {}
    }
    if (!tab) throw new Error('headless Chrome did not open DevTools on 9333')
    const ws = new WebSocket(tab.webSocketDebuggerUrl)
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
    let id = 0
    const pending = new Map()
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data)
      if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
      if (m.method === 'Runtime.consoleAPICalled') consoles.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
      if (m.method === 'Network.webSocketFrameReceived') {
        const { opcode, payloadData } = m.params.response
        frames.push(opcode === 2 ? Buffer.from(payloadData, 'base64') : Buffer.from(payloadData))
      }
    }
    const call = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
    await call('Runtime.enable')
    await call('Network.enable')
    await call('Page.navigate', { url })
    const evaluate = async (expression) => {
      const res = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (res.result?.exceptionDetails) throw new Error(`in page: ${JSON.stringify(res.result.exceptionDetails).slice(0, 500)}`)
      return res.result?.result?.value
    }
    const waitFor = async (expression, ms = 30000) => {
      for (let t = 0; t < ms; t += 500) {
        const v = await evaluate(expression).catch(() => undefined)
        if (v) return v
        await wait(500)
      }
      throw new Error(`timed out in the page waiting for ${expression}`)
    }
    const reload = () => call('Page.reload', { ignoreCache: false })
    await fn({ evaluate, waitFor, consoles, frames, reload })
    ws.close()
  } finally {
    chrome.kill('SIGKILL')
    await wait(300)
    rmSync(profile, { recursive: true, force: true })
  }
  return { consoles, frames }
}

// --- app.vlmVouch probes -------------------------------------------------------------------------------------------

// Scripts that print `typeof app.vlmVouch` and `typeof app.vlmWorld` (removed; must stay undefined), prefixed
// `[vlm-probe] <which> <server|client>`. The probe .hyp is the VLM app with its script swapped for the shipped probe, so
// it is what patch 0002 installs. On the server the shipped probe vouches for every player who enters (as the relay
// would), then for a player id that isn't in the world, then with pending pairings VLM answers 500, 401 and a redirect
// to, then with a 300-character name.
const probeLine = (which) =>
  `console.log('[vlm-probe] ${which} ' + (world.isServer ? 'server' : 'client') + ' ' + typeof app.vlmVouch + ' ' + typeof app.vlmWorld)`
const HOLD_PORT = 3212
const VLM_PORT = 3213
const VLM_URL = `http://127.0.0.1:${VLM_PORT}`
const shippedProbe = scriptAsset(`${probeLine('shipped')}
if (world.isServer && app.vlmVouch) {
  const vouch = app.vlmVouch
  const show = (which, r) => console.log('[vlm-probe] ' + which + ' server ' + JSON.stringify(r))
  world.on('enter', async (e) => {
    show('vouch', await vouch({ hyperfyPlayerId: e.playerId, playerName: 'Probe Player' }))
    show('vouch-nobody', await vouch({ hyperfyPlayerId: 'nobody', playerName: 'X' }))
    show('vouch-500', await vouch({ hyperfyPlayerId: e.playerId, playerName: 'Probe Player', pendingPairingId: 'pair-500' }))
    show('vouch-401', await vouch({ hyperfyPlayerId: e.playerId, playerName: 'Probe Player', pendingPairingId: 'pair-401' }))
    show('vouch-302', await vouch({ hyperfyPlayerId: e.playerId, playerName: 'Probe Player', pendingPairingId: 'pair-302' }))
    show('vouch-long', await vouch({ hyperfyPlayerId: e.playerId, playerName: 'x'.repeat(300) }))
  })
}
`)
// The builder's edit: reads now, and again from a callback that only runs after the shipped script is back (a server
// fetch held open until the app is rebuilt, which aborts it).
const editedProbe = scriptAsset(`${probeLine('edited')}
if (world.isServer) fetch('http://127.0.0.1:${HOLD_PORT}/hold').then(() => { ${probeLine('edited-late')} })
`)
const otherProbe = scriptAsset(`${probeLine('other')}\n`)
// A builder's app that hooks the realm's shared intrinsics, as a thief would, and prints anything secret-shaped.
const hookProbe = scriptAsset(`if (world.isServer) {
  const steal = (v) => { const t = String(v); if (t.includes('vlmws_')) console.log('[vlm-probe] stolen server ' + t) }
  Object.defineProperty(Object.prototype, 'toJSON', { configurable: true, value() { if (this && this.worldSecret) steal(this.worldSecret); return this } })
  const stringify = JSON.stringify
  JSON.stringify = function (v, ...rest) { const out = stringify(v, ...rest); if (typeof out === 'string') steal(out); return out }
  console.log('[vlm-probe] hook server installed')
}
`)
const probeDir = mkdtempSync(path.join(tmpdir(), 'vlm-world-test-hyp-'))
const probeHypPath = path.join(probeDir, 'vlm-probe.hyp')
writeHyp(probeHypPath, { ...vlmHyp.blueprint, script: shippedProbe.url }, [
  ...vlmHyp.header.assets.filter((a) => a.type !== 'script').map((a) => ({ ...a, bytes: vlmHyp.files.find((f) => `asset://${f.name}` === a.url).bytes })),
  shippedProbe,
])
const probeReads = (which, side) =>
  log.join('').split('\n').filter((l) => l.startsWith(`[vlm-probe] ${which} ${side} `)).map((l) => l.slice(`[vlm-probe] ${which} ${side} `.length))
const pageReads = (consoles, which) =>
  consoles.filter((l) => l.startsWith(`[vlm-probe] ${which} client `)).map((l) => l.slice(`[vlm-probe] ${which} client `.length))
async function until(cond, what, ms = 30000) {
  for (let t = 0; t < ms; t += 250) {
    if (cond()) return
    await wait(250)
  }
  throw new Error(`timed out waiting for ${what}:\n${log.join('').slice(-2000)}`)
}
// Waits until the page's world is loaded and stays connected. Under load, headless Chrome can miss the server's first
// ping (10 s) while the world is still initialising, and the server drops it ("disconnect" in the page's console); the
// page is then reloaded, as a player would.
async function connected({ waitFor, consoles, reload }) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const seen = consoles.length
    if (attempt) await reload()
    await waitFor(worldReady)
    await wait(12000)
    if (!consoles.slice(seen).some((l) => l.startsWith('disconnect'))) return
  }
  throw new Error('the page kept being disconnected from the world')
}
const worldReady = `!!(window.world?.blueprints?.get('vlm') && window.world.network?.id && [...window.world.entities.items.values()].some((e) => e.data?.blueprint === 'vlm'))`

// A fake VLM: records every request, answers vouch with a linked player plus fields the image must strip; for
// pendingPairingId `pair-500` 500, `pair-401` 401 (the world secret refused), `pair-302` a redirect to a path that would
// answer linked if followed.
const vlmRequests = []
const REDIRECTED = '/api/hyperfy/pairings/vouch-redirected'
const fakeVlm = createServer((req, res) => {
  let body = ''
  req.on('data', (d) => (body += d))
  req.on('end', () => {
    let json
    try { json = JSON.parse(body) } catch {}
    vlmRequests.push({ method: req.method, url: req.url, body: json, raw: body })
    res.setHeader('content-type', 'application/json')
    if (req.url !== '/api/hyperfy/pairings/vouch' && req.url !== REDIRECTED) return res.writeHead(404).end('{}')
    if (json?.pendingPairingId === 'pair-500') return res.writeHead(500).end('{"error":"boom"}')
    if (json?.pendingPairingId === 'pair-401') return res.writeHead(401).end('{"error":"invalid_world_secret"}')
    if (json?.pendingPairingId === 'pair-302' && req.url !== REDIRECTED) return res.writeHead(307, { location: REDIRECTED }).end()
    res.end(JSON.stringify({ status: 'linked', pass: 'PASS', passExpiresAt: 'x', pairingId: 'pair-1', sceneId: 'scene-1', user: { id: 'u1', displayName: 'Ada', email: 'leak@example' }, extra: 'junk' }))
  })
})
await new Promise((r) => fakeVlm.listen(VLM_PORT, '127.0.0.1', r))
const LINKED = JSON.stringify({ status: 'linked', pass: 'PASS', passExpiresAt: 'x', pairingId: 'pair-1', sceneId: 'scene-1', user: { id: 'u1', displayName: 'Ada' } })

// --- the patch module on its own -----------------------------------------------------------------------------------

// Bundles src/server/vlm.js (packages left external, resolved from the Hyperfy tree) and imports a fresh copy.
async function loadVlmModule() {
  const { build } = createRequire(path.join(srcDir, 'package.json'))('esbuild')
  const out = path.join(srcDir, `.vlm-unit-${randomBytes(4).toString('hex')}.mjs`)
  await build({ entryPoints: [path.join(srcDir, 'src/server/vlm.js')], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: out, logLevel: 'silent' })
  try {
    return await import(pathToFileURL(out).href)
  } finally {
    rmSync(out, { force: true })
  }
}

// --- tests ---------------------------------------------------------------------------------------------------------

const results = []
const only = process.env.TEST_ONLY ? new RegExp(process.env.TEST_ONLY) : null // run just the matching tests
async function test(name, fn) {
  if (only && !only.test(name)) return
  try {
    await fn()
    results.push([true, name])
    console.log(`  ok    ${name}`)
  } catch (err) {
    results.push([false, name])
    console.log(`  FAIL  ${name}\n        ${String(err.stack || err).split('\n').join('\n        ')}`)
  } finally {
    await stop()
  }
}
function eq(actual, expected, what) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${what}: expected ${e}, got ${a}`)
}
function ok(cond, what) {
  if (!cond) throw new Error(what)
}

const world = `world-vlm-test-${randomBytes(3).toString('hex')}`
const worldDir = path.join(srcDir, world)
const KEY1 = `vlmw_${randomBytes(12).toString('hex')}`
const KEY2 = `vlmw_${randomBytes(12).toString('hex')}`
const now = new Date().toISOString()
const userBlueprint = { id: 'user-box', version: 3, name: 'Box', model: 'asset://box.glb', script: null, props: { a: 1 } }
const userEntity = { id: 'userbox001', type: 'app', blueprint: 'user-box', position: [4, 0, 2], quaternion: [0, 0, 0, 1], scale: [1, 1, 1], mover: null, uploader: null, pinned: false, state: {} }

console.log(`test-world: ${srcDir}`)
try {
  await test('unit: the option bags the patch hands Worker, postMessage and fetch have no prototype', async () => {
    const m = await loadVlmModule()
    const w = m.vouchWorkerOptions({ secret: 'vlmws_FAKE_UNIT', feedUrl: VLM_URL, worldKey: 'vlmw_unit' })
    eq(Object.getPrototypeOf(w), null, 'Worker options prototype')
    for (const k of ['env', 'resourceLimits', 'workerData']) eq(Object.getPrototypeOf(w[k]), null, `Worker options.${k} prototype`)
    eq([w.eval, w.execArgv, w.stdin, w.stdout, w.stderr], [true, [], false, false, false], 'Worker options set explicitly')
    eq(Object.hasOwn(w, 'argv'), false, 'Worker options leave argv unset (with no prototype it reads undefined)')
    eq(Object.keys(w.env), [], 'the worker env (the config goes in workerData)')
    const msg = m.vouchMessage(7, { hyperfyPlayerId: 'p1', playerName: 'Pip' })
    eq(Object.getPrototypeOf(msg), null, 'postMessage payload prototype')
    eq({ ...msg }, { id: 7, hyperfyPlayerId: 'p1', playerName: 'Pip' }, 'postMessage payload')
    // only the request's own fields are read: one inherited from its prototype is not
    const inherited = Object.assign(Object.create({ pendingPairingId: 'inherited' }), { hyperfyPlayerId: 'p1', playerName: 'Pip' })
    eq({ ...m.vouchMessage(8, inherited) }, { id: 8, hyperfyPlayerId: 'p1', playerName: 'Pip' }, 'postMessage payload from a request with an inherited field')
    // vlmVouch reads the script's request through vouchRequestFields: own fields only, and nothing from a non-object
    const fields = (r) => ({ ...m.vouchRequestFields(r) })
    eq(Object.getPrototypeOf(m.vouchRequestFields({ hyperfyPlayerId: 'p1' })), null, 'request fields prototype')
    eq(fields({ hyperfyPlayerId: 'p1', playerName: 'Pip', pendingPairingId: 'pair-1' }), { hyperfyPlayerId: 'p1', playerName: 'Pip', pendingPairingId: 'pair-1' }, 'own request fields')
    const inheritedAll = Object.assign(Object.create({ hyperfyPlayerId: 'p9', playerName: 'Mallory', pendingPairingId: 'inherited' }), {})
    eq(fields(inheritedAll), {}, 'a request whose fields are all inherited')
    eq(fields(Object.assign(Object.create({ pendingPairingId: 'inherited' }), { hyperfyPlayerId: 'p1' })), { hyperfyPlayerId: 'p1' }, 'a request with an inherited pendingPairingId')
    for (const r of [null, undefined, 'p1', 42, true, () => {}]) eq(fields(r), {}, `a non-object request (${typeof r})`)
    const vouchSrc = m.vlmVouchFor.toString()
    ok(!/\.\s*(hyperfyPlayerId|playerName|pendingPairingId)\b/.test(vouchSrc), 'vlmVouchFor reads a request field by ordinary lookup')
    ok(/vouchRequestFields\(/.test(vouchSrc), 'vlmVouchFor reads the request through vouchRequestFields')
    // names are cut at 256 UTF-16 units without splitting a surrogate pair
    eq(m.truncateName('x'.repeat(300)), 'x'.repeat(256), 'a long name')
    eq(m.truncateName('x'.repeat(255) + '\u{1F600}y'), 'x'.repeat(255), 'a name whose 256th unit starts a surrogate pair')
    eq(m.truncateName('x'.repeat(254) + '\u{1F600}y'), 'x'.repeat(254) + '\u{1F600}', 'a pair that fits')
    eq(m.truncateName('Pip'), 'Pip', 'a short name')
    const init = m.vouchFetchInit('{}')
    eq(Object.getPrototypeOf(init), null, 'fetch init prototype')
    eq(Object.getPrototypeOf(init.headers), null, 'fetch headers prototype')
    eq([init.method, init.redirect, init.body, { ...init.headers }], ['POST', 'error', '{}', { 'Content-Type': 'application/json' }], 'fetch init')
  })

  await test('unit: starting the vouch worker takes the world secret out of the main thread\'s env, and the worker still vouches with it', async () => {
    const m = await loadVlmModule()
    const UNIT_SECRET = `vlmws_FAKE_UNIT_${randomBytes(6).toString('hex')}`
    const saved = { ...process.env }
    Object.assign(process.env, { VLM_WORLD_SECRET: UNIT_SECRET, VLM_FEED_URL: VLM_URL, VLM_WORLD_KEY: 'vlmw_unit' })
    try {
      vlmRequests.length = 0
      m.startVouchWorker()
      eq('VLM_WORLD_SECRET' in process.env, false, 'VLM_WORLD_SECRET still in the main thread\'s env')
      eq(m.vouchHosted(), true, 'hosted')
      eq(JSON.stringify(await m.askVouchWorker({ hyperfyPlayerId: 'p1', playerName: 'Pip' })), LINKED, 'the worker\'s vouch')
      eq(vlmRequests.map((r) => r.body), [{ worldKey: 'vlmw_unit', worldSecret: UNIT_SECRET, hyperfyPlayerId: 'p1', playerName: 'Pip' }], 'what VLM got')
      eq(await m.askVouchWorker({ hyperfyPlayerId: 'p1', playerName: 'Pip', pendingPairingId: 'pair-401' }), { status: 'unauthorized' }, 'a 401')
      eq(await m.askVouchWorker({ hyperfyPlayerId: 'p1', playerName: 'Pip', pendingPairingId: 'pair-302' }), { status: 'error' }, 'a redirect')
      eq(vlmRequests.filter((r) => r.url === REDIRECTED), [], 'requests to the redirect target')
      // a worker that exits is respawned with the very option bag built at startup (never rebuilt once scripts run)
      await m.endVouchWorkerForTest()
      eq(JSON.stringify(await m.askVouchWorker({ hyperfyPlayerId: 'p2', playerName: 'Bo' })), LINKED, 'the vouch after the worker exited')
      eq(vlmRequests.at(-1).body, { worldKey: 'vlmw_unit', worldSecret: UNIT_SECRET, hyperfyPlayerId: 'p2', playerName: 'Bo' }, 'what VLM got from the respawned worker')
      eq(m.vouchWorkerStats(), { optionsBuilt: 1, spawns: 2 }, 'option bags built (once, at startup) and workers spawned')
    } finally {
      m.stopVouchWorker()
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
      Object.assign(process.env, saved)
    }
  })

  await test('fresh boot: blueprint vlm exists with the env\'s feedUrl and worldKey, one vlm entity, $scene is the default', async () => {
    await boot(world, { VLM_WORLD_KEY: KEY1 })
    const [bp] = rowsOf(sqlite(world, `select * from blueprints where id = 'vlm'`))
    ok(bp, 'no vlm blueprint row')
    eq(bp.data.props, { ...vlmHyp.blueprint.props, feedUrl: FEED_URL, worldKey: KEY1 }, 'vlm props')
    eq(bp.data.script, vlmHyp.blueprint.script, 'vlm script')
    eq(bp.data.model, vlmHyp.blueprint.model, 'vlm model')
    const ents = rowsOf(sqlite(world, `select * from entities`)).filter((e) => e.data.blueprint === 'vlm')
    eq(ents.length, 1, 'vlm entity count')
    eq([ents[0].data.position, ents[0].data.quaternion, ents[0].data.scale], [[0, 0, 0], [0, 0, 0, 1], [1, 1, 1]], 'vlm entity transform')
    const [scene] = rowsOf(sqlite(world, `select * from blueprints where id = '$scene'`))
    ok(scene, 'no $scene blueprint')
    eq([scene.data.model, scene.data.script, scene.data.scene], [sceneHyp.blueprint.model, sceneHyp.blueprint.script, true], '$scene is the default scene.hyp')
    eq(rowsOf(sqlite(world, `select * from entities`)).filter((e) => e.data.blueprint === '$scene').length, 1, '$scene entity count')
    const seen = await probe(base, inspectWorld)
    ok(seen?.ready, `the world in Chrome did not show both apps: ${JSON.stringify(seen)}`)
    eq(seen.vlmProps.worldKey === KEY1 && seen.vlmProps.feedUrl === FEED_URL, true, 'vlm props as seen by the client')
    eq(seen.sceneModel, sceneHyp.blueprint.model, '$scene model as seen by the client')
    eq(seen.vlmEntities, [[0, 0, 0]], 'vlm entities as seen by the client')
  })

  await test('second boot with a new VLM_WORLD_KEY: blueprint vlm props updated, still one entity, user-built apps untouched', async () => {
    ok(existsSync(path.join(worldDir, 'db.sqlite')), 'no world from the first boot')
    sqlite(world, `insert into blueprints (id,data,createdAt,updatedAt) values ('user-box','${esc(JSON.stringify(userBlueprint))}','${now}','${now}')`)
    sqlite(world, `insert into entities (id,data,createdAt,updatedAt) values ('userbox001','${esc(JSON.stringify(userEntity))}','${now}','${now}')`)
    const before = sqlite(world, `select * from blueprints where id = 'user-box' union all select * from entities where id = 'userbox001'`)
    const [first] = rowsOf(sqlite(world, `select * from blueprints where id = 'vlm'`))
    const sceneBefore = sqlite(world, `select * from blueprints where id = '$scene'`)
    await boot(world, { VLM_WORLD_KEY: KEY2 })
    const [bp] = rowsOf(sqlite(world, `select * from blueprints where id = 'vlm'`))
    eq(bp.data.props, { ...vlmHyp.blueprint.props, feedUrl: FEED_URL, worldKey: KEY2 }, 'vlm props after rotation')
    ok(bp.data.version > first.data.version, `vlm blueprint version should go up (${first.data.version} -> ${bp.data.version})`)
    eq(rowsOf(sqlite(world, `select * from entities`)).filter((e) => e.data.blueprint === 'vlm').length, 1, 'vlm entity count')
    eq(sqlite(world, `select * from blueprints where id = 'user-box' union all select * from entities where id = 'userbox001'`), before, 'user-built app rows')
    eq(sqlite(world, `select * from blueprints where id = '$scene'`), sceneBefore, '$scene row')
  })

  await test('the vlm app\'s assets are served by the world', async () => {
    await boot(world, { VLM_WORLD_KEY: KEY2 })
    ok(vlmHyp.files.length > 0, 'vlm.hyp has no assets')
    for (const f of vlmHyp.files) {
      const res = await fetch(`${base}/assets/${f.name}`)
      eq(res.status, 200, `GET /assets/${f.name}`)
      ok(Buffer.from(await res.arrayBuffer()).equals(f.bytes), `served bytes of ${f.name} differ from vlm.hyp`)
    }
  })

  const sworld = `${world}-secret`
  const SECRET = `vlmws_FAKE_TEST_SECRET_${randomBytes(8).toString('hex')}`
  const secretEnv = { VLM_APP_PATH: probeHypPath, VLM_FEED_URL: VLM_URL, VLM_WORLD_KEY: KEY1, VLM_WORLD_SECRET: SECRET }
  // the Chrome player's id, as the server saw it enter
  const enteredId = () => vlmRequests.find((r) => r.url === '/api/hyperfy/pairings/vouch')?.body?.hyperfyPlayerId

  await test('the shipped vlm server script can vouch: Node posts the world secret to VLM and hands back only the expected fields', async () => {
    vlmRequests.length = 0
    await boot(sworld, secretEnv)
    await until(() => probeReads('shipped', 'server').length, 'the shipped probe on the server')
    eq(probeReads('shipped', 'server'), ['function undefined'], 'typeof app.vlmVouch / app.vlmWorld in the vlm app\'s server script')
    await session(base, async ({ waitFor }) => {
      await waitFor(worldReady)
      await until(() => probeReads('vouch-long', 'server').length, 'the probe\'s vouches')
    })
    const vouches = vlmRequests.filter((r) => r.url === '/api/hyperfy/pairings/vouch')
    eq(vlmRequests.length, vouches.length, 'only vouch requests reach VLM')
    eq(vouches.length, 5, 'vouch requests (the absent player id is refused without one)')
    const lines = log.join('').split('\n')
    const started = lines.findIndex((l) => l.startsWith('[vlm] vouch worker started'))
    ok(started >= 0 && started < lines.findIndex((l) => l.startsWith('[vlm-probe]')), 'the vouch worker did not start before the first app script ran')
    const id = enteredId()
    ok(typeof id === 'string' && id.length > 0, `no player id in the vouch: ${JSON.stringify(vouches[0]?.body)}`)
    eq(vouches[0].method, 'POST', 'vouch method')
    eq(vouches[0].body, { worldKey: KEY1, worldSecret: SECRET, hyperfyPlayerId: id, playerName: 'Probe Player' }, 'vouch body')
    eq(vouches[1].body, { worldKey: KEY1, worldSecret: SECRET, hyperfyPlayerId: id, playerName: 'Probe Player', pendingPairingId: 'pair-500' }, 'polling vouch body')
    eq(probeReads('vouch', 'server'), [LINKED], 'the vouch answer the script gets (unexpected fields stripped)')
    eq(probeReads('vouch-nobody', 'server'), ['{"status":"error"}'], 'a player id that isn\'t in the world')
    eq(probeReads('vouch-500', 'server'), ['{"status":"error"}'], 'VLM answering 500')
    eq(probeReads('vouch-401', 'server'), ['{"status":"unauthorized"}'], 'VLM refusing the world secret (401)')
    eq(probeReads('vouch-302', 'server'), ['{"status":"error"}'], 'VLM answering with a redirect (not followed)')
    eq(vlmRequests.filter((r) => r.url === REDIRECTED), [], 'requests to the redirect target')
    eq(vouches[4].body, { worldKey: KEY1, worldSecret: SECRET, hyperfyPlayerId: id, playerName: 'x'.repeat(256) }, 'a 300-character name is truncated to 256')
    eq(probeReads('vouch-long', 'server'), [LINKED], 'the vouch with a long name')
  })

  await test('client scripts and other apps see app.vlmVouch undefined', async () => {
    const otherBp = { id: 'user-probe', version: 1, name: 'Probe', model: vlmHyp.blueprint.model, script: otherProbe.url, props: {} }
    const otherEnt = { ...userEntity, id: 'userprobe01', blueprint: 'user-probe' }
    sqlite(sworld, `insert into blueprints (id,data,createdAt,updatedAt) values ('user-probe','${esc(JSON.stringify(otherBp))}','${now}','${now}')`)
    sqlite(sworld, `insert into entities (id,data,createdAt,updatedAt) values ('userprobe01','${esc(JSON.stringify(otherEnt))}','${now}','${now}')`)
    mkdirSync(path.join(srcDir, sworld, 'assets'), { recursive: true })
    writeFileSync(path.join(srcDir, sworld, 'assets', otherProbe.url.replace('asset://', '')), otherProbe.bytes)
    await boot(sworld, secretEnv)
    await until(() => probeReads('other', 'server').length && probeReads('shipped', 'server').length, 'both probes on the server')
    eq(probeReads('other', 'server'), ['undefined undefined'], 'another app\'s server script')
    eq(probeReads('shipped', 'server'), ['function undefined'], 'the vlm app\'s server script')
    await session(base, async ({ waitFor, consoles }) => {
      await waitFor(worldReady)
      await until(() => pageReads(consoles, 'shipped').length && pageReads(consoles, 'other').length, 'both probes in the page')
      eq(pageReads(consoles, 'shipped'), ['undefined undefined'], 'the vlm app\'s client script')
      eq(pageReads(consoles, 'other'), ['undefined undefined'], 'another app\'s client script')
    })
  })

  await test('a player who is neither admin nor builder is refused without calling VLM', async () => {
    vlmRequests.length = 0
    // with an admin code, a new player is a visitor
    await boot(sworld, { ...secretEnv, ADMIN_CODE: `fake-admin-code-${randomBytes(4).toString('hex')}` })
    await session(base, async ({ waitFor }) => {
      await waitFor(worldReady)
      await waitFor(`!!window.world.entities.player && !window.world.entities.player.isBuilder()`) // a visitor, not a builder
      await until(() => probeReads('vouch-long', 'server').length, 'the probe\'s vouches')
    })
    eq(probeReads('vouch', 'server'), ['{"status":"error"}'], 'vouch for a visitor')
    eq(probeReads('vouch-500', 'server'), ['{"status":"error"}'], 'polling vouch for a visitor')
    eq(probeReads('vouch-long', 'server'), ['{"status":"error"}'], 'long-named vouch for a visitor')
    eq(vlmRequests, [], 'requests to VLM')
  })

  await test('the secret never appears in any client frame, the page, /env.js, console output or the world\'s rows, nor to an app hooking JSON', async () => {
    vlmRequests.length = 0
    const hookBp = { id: 'user-hook', version: 1, name: 'Hook', model: vlmHyp.blueprint.model, script: hookProbe.url, props: {} }
    const hookEnt = { ...userEntity, id: 'userhook001', blueprint: 'user-hook' }
    sqlite(sworld, `insert into blueprints (id,data,createdAt,updatedAt) values ('user-hook','${esc(JSON.stringify(hookBp))}','${now}','${now}')`)
    sqlite(sworld, `insert into entities (id,data,createdAt,updatedAt) values ('userhook001','${esc(JSON.stringify(hookEnt))}','${now}','${now}')`)
    mkdirSync(path.join(srcDir, sworld, 'assets'), { recursive: true })
    writeFileSync(path.join(srcDir, sworld, 'assets', hookProbe.url.replace('asset://', '')), hookProbe.bytes)
    try {
      await boot(sworld, secretEnv)
      await until(() => probeReads('hook', 'server').length, 'the hooking app on the server')
      const page = await (await fetch(base)).text()
      const env = await (await fetch(`${base}/env.js`)).text()
      ok(env.includes('PUBLIC_WS_URL'), `/env.js does not look like Hyperfy's: ${env.slice(0, 200)}`)
      ok(!page.includes(SECRET), 'the secret is in the served page')
      ok(!env.includes(SECRET), 'the secret is in /env.js')
      const { frames, consoles } = await session(base, async ({ waitFor }) => {
        await waitFor(worldReady)
        await until(() => probeReads('vouch-long', 'server').length, 'the probe\'s vouches')
        await wait(2000)
      })
      ok(vlmRequests.some((r) => r.raw.includes(SECRET)), 'VLM never got the secret, so this proves nothing')
      eq(probeReads('vouch', 'server'), [LINKED], 'the vouch answer with the hooking app running')
      eq(probeReads('stolen', 'server'), [], 'what the hooking app stole')
      ok(frames.length > 0 && frames[0].length > 1000, `no client snapshot captured (${frames.length} frames, first ${frames[0]?.length} bytes)`)
      ok(frames[0].includes(Buffer.from(KEY1)), 'the captured snapshot does not carry blueprint vlm\'s props (is it the snapshot?)')
      ok(!frames.some((f) => f.includes(Buffer.from(SECRET))), 'the secret is in a packet the client received')
      ok(consoles.length > 0 && !consoles.some((l) => l.includes(SECRET)), 'the secret is in the page\'s console')
      ok(!log.join('').includes(SECRET), 'the secret is in the world\'s console output')
      for (const table of ['blueprints', 'entities', 'config']) {
        ok(!JSON.stringify(sqlite(sworld, `select * from ${table}`)).includes(SECRET), `the secret is in the world's ${table} table`)
      }
    } finally {
      // a realm-wide toJSON hook also disturbs Hyperfy itself (later script edits stall), so it only lives for this test
      await stop()
      sqlite(sworld, `delete from entities where id = 'userhook001'`)
      sqlite(sworld, `delete from blueprints where id = 'user-hook'`)
    }
  })

  await test('an edited vlm script sees app.vlmVouch undefined, even from callbacks that outlive it once the shipped script is back', async () => {
    const hold = createServer(() => {}) // never answers; the rebuild aborts the request
    await new Promise((r) => hold.listen(HOLD_PORT, '127.0.0.1', r))
    try {
      await boot(sworld, secretEnv)
      await until(() => probeReads('shipped', 'server').length, 'the shipped probe on the server')
      await session(base, async ({ evaluate, waitFor, consoles, reload }) => {
        await connected({ waitFor, consoles, reload })
        const edit = (code) => `(async () => {
          const world = window.world
          const code = ${JSON.stringify(code)}
          const bytes = new TextEncoder().encode(code)
          const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('')
          const file = new File([bytes], hash + '.js', { type: 'text/javascript' })
          const url = 'asset://' + hash + '.js'
          world.loader.insert('script', url, file)
          const version = world.blueprints.get('vlm').version + 1
          world.blueprints.modify({ id: 'vlm', version, script: url })
          await world.network.upload(file)
          world.network.send('blueprintModified', { id: 'vlm', version, script: url })
          return url
        })()`
        eq(await evaluate(edit(editedProbe.bytes.toString())), editedProbe.url, 'edited script url')
        await until(() => probeReads('edited', 'server').length, 'the edited script on the server')
        // the builder puts the shipped script back (same asset, as the editor would after an undo)
        eq(await evaluate(edit(shippedProbe.bytes.toString())), shippedProbe.url, 'restored script url')
        await until(() => probeReads('shipped', 'server').length >= 2 && probeReads('edited-late', 'server').length, 'the restored script and the edited script\'s late callback')
      })
      eq(probeReads('edited', 'server'), ['undefined undefined'], 'the edited script')
      eq(probeReads('edited-late', 'server'), ['undefined undefined'], 'the edited script\'s callback after the restore')
      eq(probeReads('shipped', 'server'), ['function undefined', 'function undefined'], 'the shipped script, at boot and once restored')
    } finally {
      hold.closeAllConnections()
      hold.close()
    }
  })

  await test('self-run (no VLM_WORLD_SECRET): the vlm app\'s server script sees app.vlmVouch undefined', async () => {
    const { VLM_WORLD_SECRET, ...selfRun } = secretEnv
    await boot(sworld, selfRun)
    await until(() => probeReads('shipped', 'server').length, 'the shipped probe on the server')
    eq(probeReads('shipped', 'server'), ['undefined undefined'], 'without VLM_WORLD_SECRET')
    ok(!log.join('').includes('[vlm] vouch worker started'), 'a self-run world started the vouch worker')
  })

  await test('boots on Postgres as a world role that cannot CREATE on the database, and installs vlm in its schema', async () => {
    const adminUrl = process.env.TEST_DATABASE_URL ||
      readFileSync(path.join(repoRoot, 'apps/server/vitest.config.ts'), 'utf8').match(/TEST_DATABASE_URL \|\| '([^']+)'/)[1]
    const u = new URL(adminUrl)
    // Before the import: the server's config reads its env once, when it loads.
    process.env.HYPERFY_WORLDS_DB_URL_TEMPLATE = `postgres://{user}:{password}@${u.host}${u.pathname}`
    const serverRequire = createRequire(path.join(repoRoot, 'apps/server/package.json'))
    const { tsImport } = serverRequire('tsx/esm/api')
    const worldsDb = await tsImport(path.join(repoRoot, 'apps/server/src/hyperfy/worlds-db.ts'), import.meta.url)
    const postgres = serverRequire('postgres')
    const slug = `t4-${randomBytes(3).toString('hex')}`
    const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
    try {
      const { dbUri, schema } = await worldsDb.createWorldDatabase(slug, worldsDb.directRunner(adminUrl))
      const [{ c }] = await admin`SELECT has_database_privilege(${schema}, current_database(), 'CREATE') AS c`
      eq(c, false, 'world role has CREATE on the database')
      await boot(`${world}-pg`, { VLM_WORLD_KEY: KEY1, DB_URI: dbUri, DB_SCHEMA: schema })
      const rows = await admin.unsafe(`SELECT data FROM "${schema}".blueprints WHERE id = 'vlm'`)
      eq(rows.length, 1, `vlm blueprint rows in ${schema}`)
      eq(JSON.parse(rows[0].data).props.worldKey === KEY1, true, 'vlm worldKey in Postgres')
      const ents = (await admin.unsafe(`SELECT data FROM "${schema}".entities`)).filter((r) => JSON.parse(r.data).blueprint === 'vlm')
      eq(ents.length, 1, 'vlm entity count in Postgres')
    } finally {
      await stop()
      await worldsDb.dropWorldDatabase(slug, worldsDb.directRunner(adminUrl)).catch((e) => console.log(`        cleanup: ${e.message}`))
      await admin.end({ timeout: 2 })
      rmSync(path.join(srcDir, `${world}-pg`), { recursive: true, force: true })
    }
  })
} finally {
  await stop()
  rmSync(worldDir, { recursive: true, force: true })
  rmSync(path.join(srcDir, `${world}-secret`), { recursive: true, force: true })
  rmSync(probeDir, { recursive: true, force: true })
  fakeVlm.closeAllConnections()
  fakeVlm.close()
}

const failed = results.filter(([pass]) => !pass).length
console.log(`\n${results.length - failed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
