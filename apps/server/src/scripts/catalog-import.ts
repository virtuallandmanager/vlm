// Usage: pnpm --filter vlm-server catalog:import <tag-file.json> <repo-root> [--check]
// Validates the tag file against catalog/packs.json, then imports into the configured database and storage.
// --check validates only. Nothing is uploaded when the tag file has errors.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTagFile } from '../catalog/tag-file.js'
import { loadPacks } from '../catalog/packs-file.js'

const PACKS_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../catalog/packs.json')

async function main() {
  const args = process.argv.slice(2)
  const check = args.includes('--check')
  const [tagFile, root] = args.filter((a) => a !== '--check')
  if (!tagFile || (!root && !check)) {
    console.error('usage: catalog:import <tag-file.json> <repo-root> [--check]')
    process.exit(2)
  }
  const packs = loadPacks(JSON.parse(readFileSync(PACKS_FILE, 'utf8')))
  const { rows, errors } = parseTagFile(JSON.parse(readFileSync(tagFile, 'utf8')), new Set(packs.map((p) => p.id)))
  for (const e of errors) console.error(e)
  console.log(`${rows.length} valid rows, ${errors.length} errors`)
  if (errors.length) process.exit(1)
  if (check) return
  const { createStorage } = await import('../storage/index.js')
  const { importCatalog } = await import('../catalog/import.js')
  const report = await importCatalog({ root, rows, packs, storage: createStorage() })
  console.log(JSON.stringify(report, null, 2))
  process.exit(report.failed.length ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
