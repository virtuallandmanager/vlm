// catalog/packs.json: every pack's id, name, source, license, attribution and source link. No database here, so
// `catalog:import --check` runs without one.
import type { CatalogLicense, CatalogSource } from 'vlm-shared'

/** One entry of catalog/packs.json. */
export type PackDef = { id: string; name: string; source: CatalogSource; license: CatalogLicense; attribution: string; sourceUrl: string }

const SOURCES = ['dhingia', 'last-slice', 'decentraland']
const LICENSES = ['mit', 'cc-by-nc-3.0', 'unstated']

/** Throws naming the first bad entry. */
export function loadPacks(json: unknown): PackDef[] {
  if (!Array.isArray(json)) throw new Error('packs file must be a JSON array')
  const ids = new Set<string>()
  json.forEach((p: any, i) => {
    const ok = p && /^[a-z0-9-]+$/.test(p.id) && typeof p.name === 'string' && SOURCES.includes(p.source) && LICENSES.includes(p.license)
      && typeof p.attribution === 'string' && typeof p.sourceUrl === 'string' && !ids.has(p.id)
    if (!ok) throw new Error(`packs entry ${i} is invalid or duplicate`)
    ids.add(p.id)
  })
  return json as PackDef[]
}
