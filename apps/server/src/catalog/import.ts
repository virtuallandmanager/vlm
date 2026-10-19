// One-off catalog import: packs first, then every tag-file row's GLB (and thumbnail) uploaded under a key derived from
// its content, upserted on (pack_id, source_ref). Safe to re-run: rows keep their id, packs keep their enabled flag.
import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import { and, eq, ne, or } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { assetLibraryItems, catalogPacks } from '../db/schema.js'
import type { StorageProvider } from '../storage/index.js'
import { glbStats } from './glb-stats.js'
import type { TagRow } from './tag-file.js'
import type { PackDef } from './packs-file.js'

export { loadPacks, type PackDef } from './packs-file.js'

export type ImportReport = {
  added: number
  updated: number
  duplicates: { sourceRef: string; keptBy: string }[]
  failed: { sourceRef: string; error: string }[]
  /** Imported, but something was left out (a thumbnail that's missing or isn't an image: placeholder for now). */
  warnings: { sourceRef: string; warning: string }[]
}

const THUMB_TYPES: Record<string, string> = { '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' }

/**
 * Reads a file inside root. Tag files and the cloned repos are data: a path, or a symlink in a repo, that leads
 * outside root is refused, so nothing private can be uploaded as a catalog file.
 */
async function readInside(root: string, rel: string): Promise<Buffer> {
  const base = await realpath(resolve(root))
  const p = await realpath(resolve(join(base, rel)))
  if (!p.startsWith(base + sep)) throw new Error(`path escapes the repo root: ${rel}`)
  return readFile(p)
}

const IMAGE_MAGIC: Record<string, (b: Buffer) => boolean> = {
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
}

/** The thumbnail's bytes and type, or why it was left out. */
async function readThumbnail(root: string, rel: string): Promise<{ data: Buffer; type: string; ext: string } | { warning: string }> {
  const ext = extname(rel).toLowerCase()
  const type = THUMB_TYPES[ext]
  if (!type) return { warning: `thumbnail type ${ext} isn't supported` }
  try {
    const data = await readInside(root, rel)
    if (!IMAGE_MAGIC[type](data)) return { warning: `thumbnail ${rel} isn't a ${type} image` }
    return { data, type, ext }
  } catch (err) {
    return { warning: `thumbnail ${rel} unreadable: ${err instanceof Error ? err.message : String(err)}` }
  }
}

export async function importCatalog(opts: { root: string; rows: TagRow[]; packs: PackDef[]; storage: StorageProvider }): Promise<ImportReport> {
  const { root, rows, packs, storage } = opts
  const report: ImportReport = { added: 0, updated: 0, duplicates: [], failed: [], warnings: [] }
  const licenseOf = new Map(packs.map((p) => [p.id, p.license]))
  for (const p of packs) {
    const { id, ...rest } = p
    // enabled is set only on creation: an admin's switch survives re-imports
    await db.insert(catalogPacks).values(p).onConflictDoUpdate({ target: catalogPacks.id, set: rest })
  }

  for (const row of rows) {
    try {
      const glb = await readInside(root, row.file)
      const hash = createHash('sha256').update(glb).digest('hex')
      const stats = await glbStats(glb)
      const existing = await db.query.assetLibraryItems.findFirst({
        where: and(eq(assetLibraryItems.packId, row.pack), eq(assetLibraryItems.sourceRef, row.sourceRef)),
      })
      const twin = await db.query.assetLibraryItems.findFirst({
        where: and(eq(assetLibraryItems.contentHash, hash), existing ? ne(assetLibraryItems.id, existing.id) : undefined,
          or(ne(assetLibraryItems.packId, row.pack), ne(assetLibraryItems.sourceRef, row.sourceRef))),
      })
      if (twin) {
        report.duplicates.push({ sourceRef: row.sourceRef, keptBy: twin.packId ?? 'upload' })
        continue
      }
      const storageKey = `catalog/${row.pack}/${hash}.glb`
      const cdnUrl = existing?.contentHash === hash && existing.cdnUrl ? existing.cdnUrl : await storage.upload(storageKey, glb, 'model/gltf-binary')
      let thumbnailUrl = existing?.thumbnailUrl ?? null
      if (row.thumbnail) {
        const thumb = await readThumbnail(root, row.thumbnail)
        if ('warning' in thumb) report.warnings.push({ sourceRef: row.sourceRef, warning: thumb.warning })
        else {
          // Keyed by the image's own hash, so a new image gets a new URL (no stale CDN copy)
          const thumbHash = createHash('sha256').update(thumb.data).digest('hex')
          thumbnailUrl = await storage.upload(`catalog/${row.pack}/${thumbHash}${thumb.ext}`, thumb.data, thumb.type)
        }
      }
      const values = {
        name: row.name, description: row.description ?? null, category: row.category, style: row.style, venueTags: row.venueTags,
        storageKey, cdnUrl, thumbnailUrl, fileSizeBytes: glb.length, triangleCount: stats.triangles, dimensions: stats.bbox,
        license: licenseOf.get(row.pack) ?? 'unstated', author: row.author, isPublic: true, uploadedBy: null,
        packId: row.pack, sourceRef: row.sourceRef, contentHash: hash,
      }
      if (existing) {
        await db.update(assetLibraryItems).set(values).where(eq(assetLibraryItems.id, existing.id))
        report.updated++
      } else {
        await db.insert(assetLibraryItems).values(values)
        report.added++
      }
    } catch (err) {
      report.failed.push({ sourceRef: row.sourceRef, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return report
}
