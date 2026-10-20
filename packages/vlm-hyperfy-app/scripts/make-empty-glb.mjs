// Writes assets/empty.glb: the smallest valid GLB, one scene with no nodes. Hyperfy apps need a model;
// the VLM app draws everything from its script. Skips when the file exists unless --force is given.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'empty.glb')

export function emptyGlb() {
  const gltf = { asset: { version: '2.0', generator: 'vlm-hyperfy-app' }, scene: 0, scenes: [{}] }
  let json = Buffer.from(JSON.stringify(gltf))
  json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]) // chunks are 4-byte aligned
  const header = Buffer.alloc(12)
  header.writeUInt32LE(0x46546c67, 0) // "glTF"
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(12 + 8 + json.length, 8)
  const chunk = Buffer.alloc(8)
  chunk.writeUInt32LE(json.length, 0)
  chunk.writeUInt32LE(0x4e4f534a, 4) // "JSON"
  return Buffer.concat([header, chunk, json])
}

if (process.argv.includes('--force') || !existsSync(out)) {
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, emptyGlb())
  console.log('wrote', out)
}
