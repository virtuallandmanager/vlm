// Bundles src/app.ts into one script and packs it with assets/empty.glb into dist/vlm.hyp, Hyperfy's app
// file (see Hyperfy's src/core/extras/appTools.js): a 4-byte little-endian header length, the JSON header
// { blueprint, assets }, then each asset's bytes in header order. Asset urls are asset://<sha256>.<ext>.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { bundleOptions } from './bundle-options.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const bundled = await build(bundleOptions(root, join(root, 'src/app.ts')))
const js = Buffer.from(bundled.outputFiles[0].contents)
const glb = readFileSync(join(root, 'assets/empty.glb'))

const sha = (b) => createHash('sha256').update(b).digest('hex')
const model = `asset://${sha(glb)}.glb`
const script = `asset://${sha(js)}.js`
const header = {
  blueprint: {
    id: 'vlm',
    version: 0,
    name: 'VLM',
    image: null,
    author: 'VLM',
    url: 'https://vlm.gg',
    desc: 'Shows a VLM scene in this world. Set the world key from VLM.',
    model,
    script,
    props: { feedUrl: 'https://api.vlm.gg', worldKey: '' },
    preload: false,
    public: false,
    locked: false,
    unique: false,
    scene: false,
    disabled: false,
  },
  assets: [
    { type: 'model', url: model, size: glb.length, mime: 'model/gltf-binary' },
    { type: 'script', url: script, size: js.length, mime: 'application/javascript' },
  ],
}
const headerBytes = Buffer.from(JSON.stringify(header))
const size = Buffer.alloc(4)
size.writeUInt32LE(headerBytes.length, 0)
mkdirSync(join(root, 'dist'), { recursive: true })
writeFileSync(join(root, 'dist/vlm.hyp'), Buffer.concat([size, headerBytes, glb, js]))
console.log(`wrote dist/vlm.hyp (script ${js.length} bytes)`)
