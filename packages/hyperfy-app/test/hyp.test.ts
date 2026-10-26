import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')

type Asset = { type: string; url: string; size: number; mime: string }
type Header = { blueprint: Record<string, unknown> & { props: Record<string, unknown> }; assets: Asset[] }

let header: Header
let files: Buffer[]

beforeAll(() => {
  execFileSync('npm', ['run', '--silent', 'build'], { cwd: pkg, stdio: 'pipe' })
  const buf = readFileSync(join(pkg, 'dist/vlm.hyp'))
  const size = buf.readUInt32LE(0)
  header = JSON.parse(buf.subarray(4, 4 + size).toString('utf8'))
  let pos = 4 + size
  files = header.assets.map((a) => {
    const f = buf.subarray(pos, pos + a.size)
    pos += a.size
    return f
  })
  expect(pos).toBe(buf.length)
}, 60_000)

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const script = () => files[header.assets.findIndex((a) => a.type === 'script')].toString('utf8')

describe('vlm.hyp', () => {
  it('build output parses back into a blueprint with model, script, the two props and the HUD icon, and every asset url is the sha256 of its bytes', () => {
    const { blueprint, assets } = header
    expect(blueprint).toMatchObject({
      name: 'VLM',
      props: { feedUrl: 'https://api.vlm.gg', worldKey: '' },
      preload: false,
    })
    expect(Object.keys(blueprint.props).sort()).toEqual(['feedUrl', 'hudIcon', 'worldKey'])
    expect(assets.map((a) => a.type)).toEqual(['model', 'script', 'texture'])
    expect(blueprint.model).toBe(assets[0].url)
    expect(blueprint.script).toBe(assets[1].url)
    // A file prop, as Hyperfy stores them: exported and uploaded with the app, read by the script as props.hudIcon.url
    expect(blueprint.props.hudIcon).toEqual({ type: 'texture', name: 'hud-v.png', url: assets[2].url })
    expect(assets[2].mime).toBe('image/png')
    expect(files[2].equals(readFileSync(join(pkg, '../dcl/assets/hud-v.png')))).toBe(true)
    assets.forEach((a, i) => {
      const ext = { model: 'glb', script: 'js', texture: 'png' }[a.type]
      expect(a.url).toBe(`asset://${sha(files[i])}.${ext}`)
      expect(a.size).toBe(files[i].length)
    })
    // The model is a GLB (magic "glTF", version 2) whose scene has no nodes.
    const glb = files[0]
    expect(glb.readUInt32LE(0)).toBe(0x46546c67)
    expect(glb.readUInt32LE(4)).toBe(2)
    expect(glb.readUInt32LE(8)).toBe(glb.length)
    const jsonLen = glb.readUInt32LE(12)
    const gltf = JSON.parse(glb.subarray(20, 20 + jsonLen).toString('utf8'))
    expect(gltf.scenes[gltf.scene].nodes ?? []).toEqual([])
    expect(gltf.nodes ?? []).toEqual([])
    expect(gltf.meshes).toBeUndefined()
  })

  it('the bundled script references no forbidden globals', () => {
    const js = script()
    expect(js).toContain('vlm:scene')
    const forbidden: Array<[string, RegExp]> = [
      ['WebSocket', /\bWebSocket\b/],
      ['TextEncoder', /\bTextEncoder\b/],
      ['setInterval', /\bsetInterval\b/],
      ['crypto', /\bcrypto\b/],
      ['localStorage', /\blocalStorage\b/],
      ['require', /\brequire\b/],
      ['import', /\bimport\b/],
      ['URL', /\bnew\s+URL\b|(?<![\w$.])URL\s*[.(]/],
      ['new Date', /\bnew\s+Date\b/],
    ]
    for (const [name, re] of forbidden) expect(re.test(js), name).toBe(false)
  })
})
