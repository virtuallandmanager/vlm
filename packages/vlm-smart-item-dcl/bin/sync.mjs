// Logic for `vlm-dcl sync`. Plain Node >= 18, node: built-ins only.
// Trusts nothing from the server: file paths are validated and confined to <cwd>/models/vlm.
import fs from 'node:fs'
import path from 'node:path'

const MB = 1024 * 1024
const FILE_RE = /^models\/vlm\/[A-Za-z0-9._-]+\.glb$/i
const MANIFEST = 'models/vlm/.vlm-sync.json'
const SIZE_EXCLUDES = new Set(['node_modules', 'bin', '.git', 'dist'])
export const DEFAULT_SERVER = 'https://api.vlm.gg'

export function locationFromSceneJson(json) {
  const world = json?.worldConfiguration?.name
  if (typeof world === 'string' && world.trim()) return `world:${world.trim().toLowerCase()}`
  const base = json?.scene?.base
  if (typeof base === 'string' && base.trim()) return `gc:${base.trim()}`
  throw new Error('scene.json has neither worldConfiguration.name nor scene.base — pass --location <key>')
}

/** Returns the absolute path if `file` is an allowed models/vlm GLB inside cwd, else null. */
function safePath(cwd, file) {
  if (typeof file !== 'string' || !FILE_RE.test(file)) return null
  const root = path.resolve(cwd, 'models', 'vlm')
  const abs = path.resolve(cwd, file)
  if (path.dirname(abs) !== root) return null
  return abs
}

function isSymlink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

function readManifest(cwd) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(cwd, MANIFEST), 'utf8'))
    return Array.isArray(m?.files) ? m.files.filter((f) => typeof f === 'string') : []
  } catch {
    return []
  }
}

function folderSize(dir, top = true) {
  let total = 0
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (top && SIZE_EXCLUDES.has(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) total += folderSize(p, false)
    else if (e.isFile()) total += fs.statSync(p).size
  }
  return total
}

function sizeOfScene(cwd) {
  const manifestAbs = path.join(cwd, MANIFEST)
  let total = folderSize(cwd)
  try {
    total -= fs.statSync(manifestAbs).size
  } catch {}
  return total
}

async function fetchModels(fetchFn, server, location) {
  const url = `${server.replace(/\/+$/, '')}/api/setup/models?location=${encodeURIComponent(location)}`
  const res = await fetchFn(url)
  if (res.status === 404) {
    throw new Error("This location isn't set up in VLM yet — walk into your deployed scene and press Set up VLM here")
  }
  if (res.status === 400) throw new Error(`The server rejected the location "${location}" as invalid (use --location gc:<x>,<y> or world:<name>)`)
  if (res.status === 429) throw new Error('Rate limited by the VLM server — wait a minute and try again')
  if (!res.ok) throw new Error(`VLM server returned HTTP ${res.status}`)
  const body = await res.json()
  if (!body || !Array.isArray(body.models)) throw new Error('Unexpected response from the VLM server')
  return body.models
}

async function download(fetchFn, url, dest) {
  const res = await fetchFn(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const tmpFile = `${dest}.${process.pid}.tmp`
  try {
    fs.writeFileSync(tmpFile, buf)
    fs.renameSync(tmpFile, dest)
  } catch (e) {
    try {
      fs.rmSync(tmpFile, { force: true })
    } catch {}
    throw e
  }
}

export async function sync({ cwd = process.cwd(), server = DEFAULT_SERVER, location, dryRun = false, fetch: fetchFn = globalThis.fetch, log = console.log } = {}) {
  let sceneJson
  try {
    sceneJson = JSON.parse(fs.readFileSync(path.join(cwd, 'scene.json'), 'utf8'))
  } catch {
    throw new Error('Could not read scene.json — run this from your scene folder')
  }
  const loc = location || locationFromSceneJson(sceneJson)
  const isWorld = loc.startsWith('world:')
  log(`Location: ${loc}`)

  const listed = await fetchModels(fetchFn, server, loc)
  const downloaded = []
  const skipped = []
  const removed = []
  const keep = new Set() // manifest files for the next manifest
  const prev = readManifest(cwd)
  const listedFiles = new Set()

  for (const m of listed) {
    const abs = safePath(cwd, m?.file)
    let urlOk = false
    try {
      urlOk = ['http:', 'https:'].includes(new URL(m?.url).protocol)
    } catch {}
    if (!abs || !urlOk) {
      log(`Warning: skipping model "${m?.name ?? m?.elementId}" — unsafe or invalid file/url from server`)
      continue
    }
    if (isSymlink(abs)) {
      log(`Warning: skipping ${m.file} — it is a symlink`)
      continue
    }
    listedFiles.add(m.file)
    let st = null
    try {
      st = fs.statSync(abs)
    } catch {}
    const need = !st || (typeof m.sizeBytes === 'number' && st.size !== m.sizeBytes)
    if (!need) {
      skipped.push(m.file)
      if (prev.includes(m.file)) keep.add(m.file)
      continue
    }
    if (!dryRun) {
      try {
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        await download(fetchFn, m.url, abs)
      } catch (e) {
        log(`Warning: failed to download ${m.file}: ${e.message}`)
        if (prev.includes(m.file)) keep.add(m.file)
        continue
      }
    }
    downloaded.push(m.file)
    keep.add(m.file)
  }

  for (const f of prev) {
    if (listedFiles.has(f)) continue
    const abs = safePath(cwd, f)
    if (!abs) {
      log(`Warning: ignoring invalid manifest entry "${f}"`)
      continue
    }
    if (isSymlink(abs)) continue
    if (fs.existsSync(abs)) {
      if (!dryRun) fs.rmSync(abs, { force: true })
      removed.push(f)
    }
  }

  if (!dryRun && (keep.size || prev.length)) {
    fs.mkdirSync(path.join(cwd, 'models', 'vlm'), { recursive: true })
    fs.writeFileSync(path.join(cwd, MANIFEST), JSON.stringify({ files: [...keep].sort() }, null, 2) + '\n')
  }

  const parcels = Array.isArray(sceneJson?.scene?.parcels) ? sceneJson.scene.parcels.length : 1
  const limitBytes = isWorld ? 100 * MB : 15 * MB * Math.max(1, parcels)
  const totalBytes = sizeOfScene(cwd)
  const over = totalBytes > limitBytes

  log(`${dryRun ? '[dry run] ' : ''}Downloaded: ${downloaded.length}, skipped (up to date): ${skipped.length}, removed: ${removed.length}`)
  for (const f of downloaded) log(`  + ${f}`)
  for (const f of removed) log(`  - ${f}`)
  log(`Scene size: ${(totalBytes / MB).toFixed(1)} MB of ${(limitBytes / MB).toFixed(0)} MB limit`)
  if (over) log('Warning: your scene is over the size limit and will fail to deploy — remove or shrink files.')

  return { downloaded, skipped, removed, totalBytes, limitBytes, over }
}
