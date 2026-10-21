// World test for VLM's Hyperfy image: boots a built, patched Hyperfy source tree locally and checks that the VLM app
// is installed as blueprint `vlm` (one entity at the origin) beside Hyperfy's default `$scene`, and that only the server
// half of the shipped VLM script can read the world's server-only values (`app.vlmWorld`, patch 0003).
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
import { fileURLToPath } from 'node:url'

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
    await fn({ evaluate, waitFor, consoles, frames })
    ws.close()
  } finally {
    chrome.kill('SIGKILL')
    await wait(300)
    rmSync(profile, { recursive: true, force: true })
  }
  return { consoles, frames }
}

// --- app.vlmWorld probes -------------------------------------------------------------------------------------------

// Scripts that print what `app.vlmWorld` reads, prefixed `[vlm-probe] <which> <server|client>`. The probe .hyp is the
// VLM app with its script swapped for the shipped probe, so it is what patch 0002 installs.
const probeLine = (which) =>
  `console.log('[vlm-probe] ${which} ' + (world.isServer ? 'server' : 'client') + ' ' + (app.vlmWorld === undefined ? 'undefined' : JSON.stringify(app.vlmWorld)))`
const HOLD_PORT = 3212
const shippedProbe = scriptAsset(`${probeLine('shipped')}\n`)
// The builder's edit: reads the values now, and again from a callback that only runs after the shipped script is back
// (a server fetch held open until the app is rebuilt, which aborts it).
const editedProbe = scriptAsset(`${probeLine('edited')}
if (world.isServer) fetch('http://127.0.0.1:${HOLD_PORT}/hold').then(() => { ${probeLine('edited-late')} })
`)
const otherProbe = scriptAsset(`${probeLine('other')}\n`)
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
const worldReady = `!!(window.world?.blueprints?.get('vlm') && window.world.network?.id && [...window.world.entities.items.values()].some((e) => e.data?.blueprint === 'vlm'))`

// --- tests ---------------------------------------------------------------------------------------------------------

const results = []
async function test(name, fn) {
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
  const secretEnv = { VLM_APP_PATH: probeHypPath, VLM_WORLD_KEY: KEY1, VLM_WORLD_SECRET: SECRET }
  const expected = JSON.stringify({ secret: SECRET, apiUrl: FEED_URL, worldKey: KEY1 })

  await test('the vlm app\'s server script reads app.vlmWorld = { secret, apiUrl, worldKey }', async () => {
    await boot(sworld, secretEnv)
    await until(() => probeReads('shipped', 'server').length, 'the shipped probe on the server')
    eq(probeReads('shipped', 'server'), [expected], 'app.vlmWorld in the vlm app\'s server script')
  })

  await test('client scripts and other apps read undefined', async () => {
    const otherBp = { id: 'user-probe', version: 1, name: 'Probe', model: vlmHyp.blueprint.model, script: otherProbe.url, props: {} }
    const otherEnt = { ...userEntity, id: 'userprobe01', blueprint: 'user-probe' }
    sqlite(sworld, `insert into blueprints (id,data,createdAt,updatedAt) values ('user-probe','${esc(JSON.stringify(otherBp))}','${now}','${now}')`)
    sqlite(sworld, `insert into entities (id,data,createdAt,updatedAt) values ('userprobe01','${esc(JSON.stringify(otherEnt))}','${now}','${now}')`)
    mkdirSync(path.join(srcDir, sworld, 'assets'), { recursive: true })
    writeFileSync(path.join(srcDir, sworld, 'assets', otherProbe.url.replace('asset://', '')), otherProbe.bytes)
    await boot(sworld, secretEnv)
    await until(() => probeReads('other', 'server').length && probeReads('shipped', 'server').length, 'both probes on the server')
    eq(probeReads('other', 'server'), ['undefined'], 'app.vlmWorld in another app\'s server script')
    eq(probeReads('shipped', 'server'), [expected], 'app.vlmWorld in the vlm app\'s server script')
    const { consoles } = await session(base, async ({ waitFor, consoles }) => {
      await waitFor(worldReady)
      await until(() => pageReads(consoles, 'shipped').length && pageReads(consoles, 'other').length, 'both probes in the page')
    })
    eq(pageReads(consoles, 'shipped'), ['undefined'], 'app.vlmWorld in the vlm app\'s client script')
    eq(pageReads(consoles, 'other'), ['undefined'], 'app.vlmWorld in another app\'s client script')
  })

  await test('the secret never appears in the client\'s snapshot or packets, the page, /env.js or the world\'s rows', async () => {
    await boot(sworld, secretEnv)
    const page = await (await fetch(base)).text()
    const env = await (await fetch(`${base}/env.js`)).text()
    ok(env.includes('PUBLIC_WS_URL'), `/env.js does not look like Hyperfy's: ${env.slice(0, 200)}`)
    ok(!page.includes(SECRET), 'the secret is in the served page')
    ok(!env.includes(SECRET), 'the secret is in /env.js')
    const { frames } = await session(base, async ({ waitFor }) => {
      await waitFor(worldReady)
      await wait(3000)
    })
    ok(frames.length > 0 && frames[0].length > 1000, `no client snapshot captured (${frames.length} frames, first ${frames[0]?.length} bytes)`)
    ok(frames[0].includes(Buffer.from(KEY1)), 'the captured snapshot does not carry blueprint vlm\'s props (is it the snapshot?)')
    ok(!frames.some((f) => f.includes(Buffer.from(SECRET))), 'the secret is in a packet the client received')
    for (const table of ['blueprints', 'entities', 'config']) {
      const rows = JSON.stringify(sqlite(sworld, `select * from ${table}`))
      ok(!rows.includes(SECRET), `the secret is in the world's ${table} table`)
    }
  })

  await test('an edited vlm script reads undefined, even from callbacks that outlive it once the shipped script is back', async () => {
    const hold = createServer(() => {}) // never answers; the rebuild aborts the request
    await new Promise((r) => hold.listen(HOLD_PORT, '127.0.0.1', r))
    try {
      await boot(sworld, secretEnv)
      await until(() => probeReads('shipped', 'server').length, 'the shipped probe on the server')
      await session(base, async ({ evaluate, waitFor }) => {
        await waitFor(worldReady)
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
      eq(probeReads('edited', 'server'), ['undefined'], 'app.vlmWorld in the edited script')
      eq(probeReads('edited-late', 'server'), ['undefined'], 'app.vlmWorld in the edited script\'s callback after the restore')
      eq(probeReads('shipped', 'server'), [expected, expected], 'app.vlmWorld in the shipped script, at boot and once restored')
    } finally {
      hold.closeAllConnections()
      hold.close()
    }
  })

  await test('self-run (no VLM_WORLD_SECRET): the vlm app\'s server script reads undefined', async () => {
    const { VLM_WORLD_SECRET, ...selfRun } = secretEnv
    await boot(sworld, selfRun)
    await until(() => probeReads('shipped', 'server').length, 'the shipped probe on the server')
    eq(probeReads('shipped', 'server'), ['undefined'], 'app.vlmWorld without VLM_WORLD_SECRET')
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
}

const failed = results.filter(([pass]) => !pass).length
console.log(`\n${results.length - failed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
