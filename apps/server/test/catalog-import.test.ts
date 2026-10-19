import { describe, it, expect, beforeEach, beforeAll } from 'vitest'
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { Document, NodeIO } from '@gltf-transform/core'
import { db } from '../src/db/connection.js'
import { assetLibraryItems, catalogPacks } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { assertStorageQuota } from '../src/media/quota.js'
import type { StorageProvider } from '../src/storage/index.js'
import { glbStats } from '../src/catalog/glb-stats.js'
import { parseTagFile, type TagRow } from '../src/catalog/tag-file.js'
import { importCatalog, type PackDef } from '../src/catalog/import.js'
import { resetDb } from './helpers/db.js'
import { createUser } from './helpers/factories.js'

/** A GLB of one unit cube (12 triangles), its node scaled by `s`. */
async function cubeGlb(s: [number, number, number] = [1, 1, 1]): Promise<Buffer> {
  const doc = new Document()
  const buffer = doc.createBuffer()
  const p = [-0.5, 0.5]
  const pos: number[] = []
  for (const x of p) for (const y of p) for (const z of p) pos.push(x, y, z)
  const faces = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]]
  const idx = faces.flatMap(([a, b, c, d]) => [a, b, c, a, c, d])
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(pos)).setBuffer(buffer))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint16Array(idx)).setBuffer(buffer))
  const node = doc.createNode().setMesh(doc.createMesh().addPrimitive(prim)).setScale(s)
  doc.createScene().addChild(node)
  return Buffer.from(await new NodeIO().writeBinary(doc))
}

const memoryStorage = () => {
  const files = new Map<string, Buffer>()
  const storage: StorageProvider = {
    upload: async (key, data) => { files.set(key, data); return `https://cdn.test/${key}` },
    delete: async (key) => { files.delete(key) },
    getPublicUrl: (key) => `https://cdn.test/${key}`,
  }
  return { storage, files }
}

const PACKS: PackDef[] = [
  { id: 'dcl-cyberpunk', name: 'Decentraland: Cyberpunk', source: 'decentraland', license: 'unstated', attribution: 'Decentraland Foundation', sourceUrl: 'https://github.com/decentraland/asset-packs' },
  { id: 'last-slice-kirzoz', name: 'Last Slice: Kirzoz', source: 'last-slice', license: 'unstated', attribution: 'Kirzoz for Last Slice', sourceUrl: 'https://github.com/last-slice/iwb-3d-wip' },
]
const row = (over: Partial<TagRow>): TagRow => ({
  pack: 'last-slice-kirzoz', sourceRef: 'Kirzoz/Chair.glb', file: 'Kirzoz/Chair.glb', name: 'Chair', author: 'Kirzoz',
  style: 'Cozy', category: 'Furniture', venueTags: ['cafe'], confidence: 1, ...over,
})

describe('glbStats', () => {
  it('counts triangles and measures the box', async () => {
    expect(await glbStats(await cubeGlb())).toEqual({ triangles: 12, bbox: { x: 1, y: 1, z: 1 } })
    expect((await glbStats(await cubeGlb([2, 1, 3]))).bbox).toEqual({ x: 2, y: 1, z: 3 })
  })

  it('throws on a corrupt file', async () => {
    await expect(glbStats(Buffer.from('not a glb'))).rejects.toThrow()
  })
})

describe('parseTagFile', () => {
  const ids = new Set(PACKS.map((p) => p.id))
  it('rejects unknown style, category, venue and pack, naming the row', () => {
    const { rows, errors } = parseTagFile([
      row({}),
      row({ sourceRef: 'b', style: 'Groovy' as any }),
      row({ sourceRef: 'c', category: 'Thing' as any }),
      row({ sourceRef: 'd', venueTags: ['moon'] as any }),
      row({ sourceRef: 'e', pack: 'nope' }),
      row({ sourceRef: 'f', file: '' }),
    ], ids)
    expect(rows).toHaveLength(1)
    expect(errors).toHaveLength(5)
    expect(errors[0]).toMatch(/row 1/)
    expect(errors[3]).toMatch(/row 4/)
  })

  it('rejects duplicate sourceRef within a pack', () => {
    const { rows, errors } = parseTagFile([row({}), row({}), row({ pack: 'dcl-cyberpunk' })], ids)
    expect(rows).toHaveLength(2)
    expect(errors).toEqual([expect.stringMatching(/row 1.*duplicate/)])
  })

  it('accepts a null style', () => {
    expect(parseTagFile([row({ style: null })], ids).errors).toEqual([])
  })
})

describe('importCatalog', () => {
  let root: string
  let cube: Buffer
  beforeAll(async () => { cube = await cubeGlb() })
  beforeEach(async () => {
    await resetDb()
    root = mkdtempSync(join(tmpdir(), 'catalog-'))
    mkdirSync(join(root, 'Kirzoz'))
    writeFileSync(join(root, 'Kirzoz/Chair.glb'), cube)
    writeFileSync(join(root, 'Kirzoz/Chair.png'), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('chair')]))
    writeFileSync(join(root, 'Kirzoz/Table.glb'), await cubeGlb([2, 1, 3]))
    writeFileSync(join(root, 'Kirzoz/Broken.glb'), Buffer.from('nope'))
  })
  const all = () => db.select().from(assetLibraryItems)

  it('imports models as public catalog rows with no uploader', async () => {
    const { storage, files } = memoryStorage()
    const report = await importCatalog({ root, packs: PACKS, storage, rows: [row({ thumbnail: 'Kirzoz/Chair.png' })] })
    expect(report).toMatchObject({ added: 1, updated: 0, duplicates: [], failed: [], warnings: [] })
    const [m] = await all()
    expect(m).toMatchObject({ packId: 'last-slice-kirzoz', isPublic: true, uploadedBy: null, name: 'Chair', author: 'Kirzoz', style: 'Cozy', category: 'Furniture', venueTags: ['cafe'], triangleCount: 12, dimensions: { x: 1, y: 1, z: 1 }, fileSizeBytes: cube.length, license: 'unstated' })
    expect(m.storageKey).toMatch(/^catalog\/last-slice-kirzoz\/[0-9a-f]{64}\.glb$/)
    expect(m.cdnUrl).toBe(`https://cdn.test/${m.storageKey}`)
    expect(m.thumbnailUrl).toMatch(/^https:\/\/cdn\.test\/catalog\/last-slice-kirzoz\/[0-9a-f]{64}\.png$/)
    expect(files.size).toBe(2)
    expect(await db.query.catalogPacks.findFirst({ where: eq(catalogPacks.id, 'dcl-cyberpunk') })).toMatchObject({ enabled: true })
  })

  it('re-import updates in place: same id, same cdnUrl, no new rows', async () => {
    const { storage } = memoryStorage()
    await importCatalog({ root, packs: PACKS, storage, rows: [row({})] })
    const [before] = await all()
    const report = await importCatalog({ root, packs: PACKS, storage, rows: [row({ style: 'Modern', name: 'Armchair' })] })
    expect(report).toMatchObject({ added: 0, updated: 1 })
    const rows = await all()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: before.id, cdnUrl: before.cdnUrl, style: 'Modern', name: 'Armchair' })
  })

  it('re-import keeps a pack disabled', async () => {
    const { storage } = memoryStorage()
    await importCatalog({ root, packs: PACKS, storage, rows: [row({})] })
    await db.update(catalogPacks).set({ enabled: false }).where(eq(catalogPacks.id, 'last-slice-kirzoz'))
    await importCatalog({ root, packs: PACKS, storage, rows: [row({})] })
    expect((await db.query.catalogPacks.findFirst({ where: eq(catalogPacks.id, 'last-slice-kirzoz') }))!.enabled).toBe(false)
  })

  it('a pack defined with enabled: false starts off, and re-imports leave an admin switch alone', async () => {
    const { storage } = memoryStorage()
    const packs = [...PACKS, { ...PACKS[1], id: 'last-slice-game-kit', name: 'Last Slice: Game kit', enabled: false }]
    await importCatalog({ root, packs, storage, rows: [row({ pack: 'last-slice-game-kit' })] })
    const kit = () => db.query.catalogPacks.findFirst({ where: eq(catalogPacks.id, 'last-slice-game-kit') })
    expect((await kit())!.enabled).toBe(false)
    await db.update(catalogPacks).set({ enabled: true }).where(eq(catalogPacks.id, 'last-slice-game-kit'))
    await importCatalog({ root, packs, storage, rows: [row({ pack: 'last-slice-game-kit' })] })
    expect((await kit())!.enabled).toBe(true)
  })

  it('moving a model to another pack of the same source moves its row: same id, same cdnUrl', async () => {
    const { storage } = memoryStorage()
    const packs = [...PACKS, { ...PACKS[1], id: 'last-slice-game-kit', name: 'Last Slice: Game kit' }]
    await importCatalog({ root, packs, storage, rows: [row({})] })
    const [before] = await all()
    const report = await importCatalog({ root, packs, storage, rows: [row({ pack: 'last-slice-game-kit' })] })
    expect(report).toMatchObject({ added: 0, updated: 1, duplicates: [] })
    const rows = await all()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: before.id, cdnUrl: before.cdnUrl, storageKey: before.storageKey, packId: 'last-slice-game-kit' })
  })

  it('the same sourceRef in a pack of another source is not a move', async () => {
    const { storage } = memoryStorage()
    await importCatalog({ root, packs: PACKS, storage, rows: [row({ pack: 'dcl-cyberpunk' })] })
    const report = await importCatalog({ root, packs: PACKS, storage, rows: [row({})] })
    expect(report.duplicates).toEqual([{ sourceRef: 'Kirzoz/Chair.glb', keptBy: 'dcl-cyberpunk' }])
    expect((await all())[0].packId).toBe('dcl-cyberpunk')
  })

  it('skips a file already in another pack and reports it', async () => {
    const { storage } = memoryStorage()
    await importCatalog({ root, packs: PACKS, storage, rows: [row({ pack: 'dcl-cyberpunk', sourceRef: 'cyberpunk/chair' })] })
    const report = await importCatalog({ root, packs: PACKS, storage, rows: [row({})] })
    expect(report.added).toBe(0)
    expect(report.duplicates).toEqual([{ sourceRef: 'Kirzoz/Chair.glb', keptBy: 'dcl-cyberpunk' }])
    expect(await all()).toHaveLength(1)
  })

  it('a corrupt file is reported and the rest still import', async () => {
    const { storage } = memoryStorage()
    const report = await importCatalog({ root, packs: PACKS, storage, rows: [
      row({}), row({ sourceRef: 'Kirzoz/Broken.glb', file: 'Kirzoz/Broken.glb' }), row({ sourceRef: 'Kirzoz/Table.glb', file: 'Kirzoz/Table.glb' }),
    ] })
    expect(report.added).toBe(2)
    expect(report.failed).toEqual([{ sourceRef: 'Kirzoz/Broken.glb', error: expect.any(String) }])
  })

  it('a missing file is reported as failed', async () => {
    const { storage } = memoryStorage()
    const report = await importCatalog({ root, packs: PACKS, storage, rows: [row({ sourceRef: 'x', file: 'Kirzoz/Missing.glb' })] })
    expect(report.failed.map((f) => f.sourceRef)).toEqual(['x'])
  })

  it('refuses a thumbnail that is a symlink out of the repo, and does not upload it', async () => {
    const secret = join(mkdtempSync(join(tmpdir(), 'secret-')), 'id_rsa')
    writeFileSync(secret, 'PRIVATE KEY')
    symlinkSync(secret, join(root, 'Kirzoz/Evil.png'))
    const { storage, files } = memoryStorage()
    const report = await importCatalog({ root, packs: PACKS, storage, rows: [row({ thumbnail: 'Kirzoz/Evil.png' })] })
    expect([...files.values()].some((b) => b.toString() === 'PRIVATE KEY')).toBe(false)
    expect(report.warnings.map((w) => w.sourceRef)).toEqual(['Kirzoz/Chair.glb'])
  })

  it('refuses a GLB that is a symlink out of the repo', async () => {
    const outside = join(mkdtempSync(join(tmpdir(), 'outside-')), 'x.glb')
    writeFileSync(outside, cube)
    symlinkSync(outside, join(root, 'Kirzoz/Linked.glb'))
    const { storage } = memoryStorage()
    const report = await importCatalog({ root, packs: PACKS, storage, rows: [row({ sourceRef: 'l', file: 'Kirzoz/Linked.glb' })] })
    expect(report.failed.map((f) => f.sourceRef)).toEqual(['l'])
  })

  it('a thumbnail that is not an image is skipped with a warning; the model still imports', async () => {
    writeFileSync(join(root, 'Kirzoz/Fake.png'), Buffer.from('<html>not an image</html>'))
    const { storage, files } = memoryStorage()
    const report = await importCatalog({ root, packs: PACKS, storage, rows: [row({ thumbnail: 'Kirzoz/Fake.png' })] })
    expect(report.added).toBe(1)
    expect(report.warnings).toEqual([{ sourceRef: 'Kirzoz/Chair.glb', warning: expect.stringMatching(/thumbnail/) }])
    expect(files.size).toBe(1)
    expect((await all())[0].thumbnailUrl).toBeNull()
  })

  it('a missing thumbnail keeps the model (placeholder until it exists)', async () => {
    const { storage } = memoryStorage()
    const report = await importCatalog({ root, packs: PACKS, storage, rows: [row({ thumbnail: 'Kirzoz/Nope.png' })] })
    expect(report.added).toBe(1)
    expect(report.failed).toEqual([])
    expect(report.warnings).toHaveLength(1)
  })

  it('a real PNG thumbnail uploads under its own content hash', async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest')])
    writeFileSync(join(root, 'Kirzoz/Real.png'), png)
    const { storage } = memoryStorage()
    await importCatalog({ root, packs: PACKS, storage, rows: [row({ thumbnail: 'Kirzoz/Real.png' })] })
    const [m] = await all()
    const { createHash } = await import('node:crypto')
    expect(m.thumbnailUrl).toBe(`https://cdn.test/catalog/last-slice-kirzoz/${createHash('sha256').update(png).digest('hex')}.png`)
  })

  it('catalog rows never count toward storage', async () => {
    const prev = config.allFeaturesUnlocked
    config.allFeaturesUnlocked = false
    try {
      const u = await createUser()
      const { storage } = memoryStorage()
      await importCatalog({ root, packs: PACKS, storage, rows: [row({})] })
      await db.update(assetLibraryItems).set({ fileSizeBytes: 2_000_000_000 }) // 2 GB: far over the free tier if counted
      await expect(assertStorageQuota(u.id, 1)).resolves.toBeUndefined()
    } finally {
      config.allFeaturesUnlocked = prev
    }
  })
})
