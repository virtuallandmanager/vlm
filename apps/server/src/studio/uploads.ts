import { and, asc, eq, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { studioUploads } from '../db/schema.js'
import { getStudioStore, uploadKey } from './store.js'
import type { Design } from './designs.js'
import sharp from 'sharp'

/**
 * Files the owner gives the agent: images (a logo for a shirt, a texture, a reference photo) and 3D files. A file's
 * kind comes from its contents, never its name alone. Every prompt job lists the design's uploads (`uploadPaths`), and its worker
 * reads them through the inputs route into the workspace's uploads/ folder.
 */

export const UPLOAD_LIMITS = { imageBytes: 20 * 1024 * 1024, modelBytes: 25 * 1024 * 1024, perDesign: 12 }
/** A vector logo or drawing becomes a picture this many pixels on its long side: a full texture's size. */
const SVG_PIXELS = 2048

type Prepared = { kind: 'image' | 'model'; contentType: string; ext: string; body: Buffer }

const ext = (name: string) => (/\.([A-Za-z0-9]+)$/.exec(name)?.[1] ?? '').toLowerCase()
const isGlb = (b: Buffer) => b.length >= 12 && b.toString('latin1', 0, 4) === 'glTF' && b.readUInt32LE(4) === 2

/** A 3D file Blender opens, from its contents (the name only picks between formats with the same contents). */
function model(b: Buffer, name: string): Prepared | null {
  const m = (contentType: string, e: string) => ({ kind: 'model' as const, contentType, ext: e, body: b })
  if (isGlb(b)) return ext(name) === 'vrm' ? m('model/gltf-binary', 'vrm') : m('model/gltf-binary', 'glb')
  if (b.toString('latin1', 0, 20) === 'Kaydara FBX Binary  ') return m('application/octet-stream', 'fbx')
  if (b.toString('latin1', 0, 7) === 'BLENDER') return m('application/x-blender', 'blend')
  // Binary STL: an 80-byte header, a triangle count, then 50 bytes a triangle
  if (ext(name) === 'stl' && b.length >= 84 && b.length === 84 + 50 * b.readUInt32LE(80)) return m('model/stl', 'stl')
  const head = b.subarray(0, 4096).toString('latin1')
  if (/^[\t\n\r\x20-\x7e]*$/.test(head)) {
    if (ext(name) === 'stl' && /^\s*solid\b/.test(head) && /\bfacet\b/.test(head)) return m('model/stl', 'stl')
    // OBJ: text whose lines are vertices and faces
    if (ext(name) === 'obj' && /^v\s+-?[\d.]/m.test(head) && /^f\s+\d/m.test(b.toString('latin1'))) return m('model/obj', 'obj')
  }
  return null
}

/**
 * The file as it is stored: PNG, JPEG and WebP images as they are; GIF, TIFF, AVIF and SVG (a logo, often) as PNG, so
 * the agent and the page can always open them; 3D files as they are. Null when it is neither.
 */
export async function prepareUpload(b: Buffer, name: string): Promise<Prepared | null> {
  if (!b.length) return null
  const asModel = model(b, name)
  if (asModel) return asModel
  let meta: sharp.Metadata
  try {
    meta = await sharp(b, { failOn: 'error' }).metadata()
  } catch {
    return null
  }
  const keep: Record<string, [string, string]> = { png: ['image/png', 'png'], jpeg: ['image/jpeg', 'jpg'], webp: ['image/webp', 'webp'] }
  if (meta.format && keep[meta.format] && !(meta.pages && meta.pages > 1)) {
    return { kind: 'image', contentType: keep[meta.format][0], ext: keep[meta.format][1], body: b }
  }
  if (!meta.format || !['gif', 'tiff', 'heif', 'svg', 'webp', 'png'].includes(meta.format)) return null
  try {
    const long = Math.max(meta.width ?? 0, meta.height ?? 0) || SVG_PIXELS
    const img = meta.format === 'svg'
      ? sharp(b, { density: Math.min(2400, Math.max(1, (72 * SVG_PIXELS) / long)) })
      : sharp(b, { pages: 1 }) // an animation's first frame
    return { kind: 'image', contentType: 'image/png', ext: 'png', body: await img.png().toBuffer() }
  } catch {
    return null // e.g. an HEIC photo: the standard sharp build can't decode it
  }
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
  if (body.length > Math.max(UPLOAD_LIMITS.imageBytes, UPLOAD_LIMITS.modelBytes)) throw new UploadError(413, 'file_too_large')
  const sniffed = await prepareUpload(body, rawName)
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
      designId: design.id, name, kind: sniffed.kind, contentType: sniffed.contentType, size: sniffed.body.length,
    }).returning()
    // Stored inside the transaction: a failed put leaves no row pointing at nothing
    await getStudioStore().put(uploadKey(design.id, u.id), sniffed.body, sniffed.contentType)
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
