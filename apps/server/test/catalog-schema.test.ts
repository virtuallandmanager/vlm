import { describe, it, expect, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { assetLibraryItems, catalogPacks } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'

const pack = (id: string) => ({ id, name: id, source: 'dhingia', license: 'mit', attribution: 'Copyright (c) 2022 Mr Dhingia', sourceUrl: 'https://github.com/MrDhingia/DhingiaBuilds' })
const item = (packId: string, sourceRef = 'a/b.glb') => ({
  name: 'Chair', storageKey: `catalog/${packId}/${sourceRef}`, packId, style: 'Cozy', venueTags: ['cafe'], sourceRef, contentHash: 'h',
})

describe('catalog schema', () => {
  beforeEach(async () => { await resetDb() })

  it('stores a pack and a catalog model', async () => {
    await db.insert(catalogPacks).values(pack('dhingia-interiors'))
    const [row] = await db.insert(assetLibraryItems).values(item('dhingia-interiors')).returning()
    const back = await db.query.assetLibraryItems.findFirst({ where: eq(assetLibraryItems.id, row.id) })
    expect(back).toMatchObject({ packId: 'dhingia-interiors', style: 'Cozy', venueTags: ['cafe'], sourceRef: 'a/b.glb', contentHash: 'h' })
    const p = await db.query.catalogPacks.findFirst({ where: eq(catalogPacks.id, 'dhingia-interiors') })
    expect(p!.enabled).toBe(true)
  })

  it('refuses a second item with the same pack and source ref', async () => {
    await db.insert(catalogPacks).values(pack('p1'))
    await db.insert(assetLibraryItems).values(item('p1'))
    await expect(db.insert(assetLibraryItems).values(item('p1'))).rejects.toThrow()
  })

  it('allows the same source ref in different packs', async () => {
    await db.insert(catalogPacks).values([pack('p1'), pack('p2')])
    await db.insert(assetLibraryItems).values(item('p1'))
    await expect(db.insert(assetLibraryItems).values(item('p2'))).resolves.toBeDefined()
  })
})
