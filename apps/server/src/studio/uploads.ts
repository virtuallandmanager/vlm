import { and, asc, eq, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { studioUploads } from '../db/schema.js'
import { getStudioStore, uploadKey } from './store.js'
import type { Design } from './designs.js'

/**
 * Files the owner gives the agent: images (a logo for a shirt, a texture, a reference photo) and GLBs. A file's kind
 * comes from its bytes, never its name. Every prompt job lists the design's uploads (`uploadPaths`), and its worker
 * reads them through the inputs route into the workspace's uploads/ folder.
 */

export const UPLOAD_LIMITS = { imageBytes: 10 * 1024 * 1024, modelBytes: 25 * 1024 * 1024, perDesign: 12 }

type Sniffed = { kind: 'image' | 'model'; contentType: string; ext: string }

/** The file's real type from its first bytes: PNG, JPEG, WebP or binary glTF, else null. */
export function sniffUpload(b: Buffer): Sniffed | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { kind: 'image', contentType: 'image/png', ext: 'png' }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: 'image', contentType: 'image/jpeg', ext: 'jpg' }
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return { kind: 'image', contentType: 'image/webp', ext: 'webp' }
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'glTF' && b.readUInt32LE(4) === 2) return { kind: 'model', contentType: 'model/gltf-binary', ext: 'glb' }
  return null
}

/** A safe file name for the agent's folder: the base name's letters, digits, dots and dashes, with the real extension. */
export function cleanName(raw: string, ext: string): string {
  const base = (raw.split(/[\\/]/).pop() ?? '').replace(/\.[^.]*$/, '')
  const stem = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60)
  return `${stem || (ext === 'glb' ? 'model' : 'image')}.${ext}`
}

export class UploadError extends Error {
  constructor(public status: number, public code: string) {
    super(code)
  }
}

export const publicUpload = (u: typeof studioUploads.$inferSelect) =>
  ({ id: u.id, name: u.name, kind: u.kind, contentType: u.contentType, size: u.size, createdAt: u.createdAt })

export async function addUpload(design: Design, rawName: string, body: Buffer) {
  if (design.archivedAt) throw new UploadError(409, 'archived')
  const sniffed = body.length ? sniffUpload(body) : null
  if (!sniffed) throw new UploadError(400, 'unsupported_file')
  if (body.length > (sniffed.kind === 'model' ? UPLOAD_LIMITS.modelBytes : UPLOAD_LIMITS.imageBytes)) throw new UploadError(413, 'file_too_large')

  const row = await db.transaction(async (tx) => {
    // Serialize a design's uploads so the count and the name stay right under concurrent requests
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`studio-uploads:${design.id}`}))`)
    const existing = await tx.select({ name: studioUploads.name }).from(studioUploads).where(eq(studioUploads.designId, design.id))
    if (existing.length >= UPLOAD_LIMITS.perDesign) throw new UploadError(409, 'too_many_uploads')
    const taken = new Set(existing.map((e) => e.name.toLowerCase()))
    const first = cleanName(rawName, sniffed.ext)
    let name = first
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = first.replace(/(\.[a-z]+)$/, `-${n}$1`)
    const [u] = await tx.insert(studioUploads).values({
      designId: design.id, name, kind: sniffed.kind, contentType: sniffed.contentType, size: body.length,
    }).returning()
    // Stored inside the transaction: a failed put leaves no row pointing at nothing
    await getStudioStore().put(uploadKey(design.id, u.id), body, sniffed.contentType)
    return u
  })
  return publicUpload(row)
}

export async function listUploads(designId: string) {
  return db.select().from(studioUploads).where(eq(studioUploads.designId, designId)).orderBy(asc(studioUploads.createdAt), asc(studioUploads.id))
}

export async function findUpload(designId: string, uploadId: string) {
  const [u] = await db.select().from(studioUploads).where(and(eq(studioUploads.designId, designId), eq(studioUploads.id, uploadId)))
  return u ?? null
}

export async function deleteUpload(designId: string, uploadId: string): Promise<boolean> {
  const [gone] = await db.delete(studioUploads)
    .where(and(eq(studioUploads.designId, designId), eq(studioUploads.id, uploadId))).returning({ id: studioUploads.id })
  if (!gone) return false
  await getStudioStore().deletePrefix(uploadKey(designId, uploadId))
  return true
}

/** What a prompt job lists for its worker: the input path to read, the name the agent sees, and its kind. */
export async function uploadPaths(designId: string, exec: Pick<typeof db, 'select'> = db) {
  const rows = await exec.select().from(studioUploads).where(eq(studioUploads.designId, designId))
    .orderBy(asc(studioUploads.createdAt), asc(studioUploads.id))
  return rows.map((u) => ({ path: `uploads/${u.id}/${u.name}`, name: u.name, kind: u.kind }))
}
