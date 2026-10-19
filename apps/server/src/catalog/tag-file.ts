// Tag files: one row per catalog model (catalog/tags/<source>.json), drafted from the source repos and spot-checked
// before import. Tags are data: fix a row and re-run the import.
import { CATALOG_CATEGORIES, CATALOG_STYLES, CATALOG_VENUES } from 'vlm-shared'
import type { CatalogCategory, CatalogStyle, CatalogVenue } from 'vlm-shared'

export type TagRow = {
  pack: string
  /** The item's id or path in its source; unique within a pack. */
  sourceRef: string
  /** Relative to the repo root given to the import. */
  file: string
  thumbnail?: string
  name: string
  description?: string
  author: string
  style: CatalogStyle | null
  category: CatalogCategory
  venueTags: CatalogVenue[]
  /** 0..1: 1 when the source gave the value, lower for guesses. */
  confidence: number
}

const has = (list: readonly string[], v: unknown) => typeof v === 'string' && list.includes(v)
const text = (v: unknown) => typeof v === 'string' && v.trim() !== ''

/** Valid rows, and one error per invalid row naming its index (0-based). Invalid rows are left out. */
export function parseTagFile(json: unknown, packIds: Set<string>): { rows: TagRow[]; errors: string[] } {
  const rows: TagRow[] = []
  const errors: string[] = []
  if (!Array.isArray(json)) return { rows, errors: ['tag file must be a JSON array'] }
  const seen = new Set<string>()
  json.forEach((r: any, i) => {
    const problems: string[] = []
    if (!r || typeof r !== 'object') return errors.push(`row ${i}: not an object`)
    if (!packIds.has(r.pack)) problems.push(`unknown pack ${JSON.stringify(r.pack)}`)
    for (const k of ['sourceRef', 'file', 'name', 'author'] as const) if (!text(r[k])) problems.push(`missing ${k}`)
    if (r.style !== null && !has(CATALOG_STYLES, r.style)) problems.push(`unknown style ${JSON.stringify(r.style)}`)
    if (!has(CATALOG_CATEGORIES, r.category)) problems.push(`unknown category ${JSON.stringify(r.category)}`)
    if (!Array.isArray(r.venueTags) || !r.venueTags.every((v: unknown) => has(CATALOG_VENUES, v))) problems.push(`unknown venue in ${JSON.stringify(r.venueTags)}`)
    if (typeof r.confidence !== 'number' || r.confidence < 0 || r.confidence > 1) problems.push('confidence must be 0..1')
    if (r.thumbnail !== undefined && !text(r.thumbnail)) problems.push('empty thumbnail')
    const key = `${r.pack}\u0000${r.sourceRef}`
    if (!problems.length && seen.has(key)) problems.push(`duplicate sourceRef ${JSON.stringify(r.sourceRef)} in pack ${r.pack}`)
    if (problems.length) return errors.push(`row ${i}: ${problems.join('; ')}`)
    seen.add(key)
    rows.push(r as TagRow)
  })
  return { rows, errors }
}
