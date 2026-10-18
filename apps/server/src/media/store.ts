import { randomUUID } from 'crypto'
import { db } from '../db/connection.js'
import { mediaAssets } from '../db/schema.js'
import { assertStorageQuota } from './quota.js'
import { createStorage } from '../storage/index.js'
import { classifyUpload, extensionFor } from '../storage/upload-policy.js'

const storage = createStorage()

export class StoreMediaError extends Error {
  constructor(public status: number, public body: Record<string, unknown>) {
    super(typeof body.error === 'string' ? body.error : 'store_media_failed')
  }
}

/** Classify, quota-check (against ownerId), upload and record a media file. Throws StoreMediaError for refusals. */
export async function storeMedia(
  ownerId: string,
  file: { filename: string; contentType: string; data: Buffer },
  opts: { quotaMessage?: string; quotaStatus?: number } = {},
): Promise<typeof mediaAssets.$inferSelect> {
  const { filename, contentType, data: buffer } = file

  const verdict = classifyUpload(filename, contentType, buffer.length)
  if (!verdict.ok) throw new StoreMediaError(verdict.status, { error: verdict.error })
  const storedType = verdict.contentType

  await assertStorageQuota(ownerId, buffer.length, opts)

  const key = `${ownerId}/${randomUUID()}.${extensionFor(storedType)}`
  const publicUrl = await storage.upload(key, buffer, storedType)

  const [asset] = await db.insert(mediaAssets).values({
    ownerId,
    filename,
    contentType: storedType,
    sizeBytes: buffer.length,
    storageKey: key,
    publicUrl,
  }).returning()
  return asset
}
