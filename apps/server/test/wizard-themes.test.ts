import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { THEMES, CATEGORY_CHIPS } from '../src/wizard/themes.js'

const catalogDir = fileURLToPath(new URL('../../../catalog/', import.meta.url))
const packs: Array<{ id: string }> = JSON.parse(readFileSync(`${catalogDir}packs.json`, 'utf8'))
const tagged = new Map<string, { category: string }>()
for (const f of ['decentraland', 'dhingia', 'last-slice']) {
  for (const i of JSON.parse(readFileSync(`${catalogDir}tags/${f}.json`, 'utf8'))) tagged.set(`${i.pack}\n${i.sourceRef}`, i)
}
const key = (r: { pack: string; sourceRef: string }) => `${r.pack}\n${r.sourceRef}`

describe('wizard themes', () => {
  it('has the six expected ids, unique', () => {
    expect(THEMES.map((t) => t.id)).toEqual(['little-park', 'cozy-cafe', 'gallery', 'beach-hangout', 'stage-venue', 'empty'])
  })

  it('keeps every x and z inside the plot and rotations finite', () => {
    for (const t of THEMES) for (const i of t.items) {
      expect(i.x).toBeGreaterThanOrEqual(0); expect(i.x).toBeLessThanOrEqual(1)
      expect(i.z).toBeGreaterThanOrEqual(0); expect(i.z).toBeLessThanOrEqual(1)
      expect(Number.isFinite(i.rotationY)).toBe(true)
    }
  })

  it('keeps themes small and the empty plot empty', () => {
    for (const t of THEMES) {
      if (t.id === 'empty') expect(t.items).toEqual([])
      else { expect(t.items.length).toBeGreaterThanOrEqual(8); expect(t.items.length).toBeLessThanOrEqual(15) }
    }
  })

  it('only references packs and items that exist in the repo catalog data', () => {
    const packIds = new Set(packs.map((p) => p.id))
    for (const r of [...THEMES.flatMap((t) => t.items), ...CATEGORY_CHIPS.flatMap((c) => c.picks)]) {
      expect(packIds.has(r.pack), r.pack).toBe(true)
      expect(tagged.has(key(r)), key(r)).toBe(true)
    }
  })

  it('has the five chips with 12-24 picks each, in the chip categories', () => {
    expect(CATEGORY_CHIPS.map((c) => c.id)).toEqual(['nature', 'furniture', 'lighting', 'buildings', 'decor'])
    for (const c of CATEGORY_CHIPS) {
      expect(c.picks.length).toBeGreaterThanOrEqual(12); expect(c.picks.length).toBeLessThanOrEqual(24)
      expect(new Set(c.picks.map(key)).size).toBe(c.picks.length)
      for (const p of c.picks) expect(c.categories, key(p)).toContain(tagged.get(key(p))!.category)
    }
  })
})
