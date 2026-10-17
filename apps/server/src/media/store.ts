import { randomUUID } from 'crypto'
import { eq, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { mediaAssets } from '../db/schema.js'
import { config } from '../config.js'
import { getSubscription } from '../integrations/stripe.js'
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

  // Enforce storage quota based on subscription tier (skip in self-hosted mode)
  if (!config.allFeaturesUnlocked) {
    const sub = await getSubscription(ownerId)
    const storageLimit = sub.limits.storageBytes

    const [{ usedBytes }] = await db
      .select({ usedBytes: sql<number>`coalesce(sum(${mediaAssets.sizeBytes}), 0)::int` })
      .from(mediaAssets)
      .where(eq(mediaAssets.ownerId, ownerId))

    if (usedBytes + buffer.length > storageLimit) {
      throw new StoreMediaError(opts.quotaStatus ?? 403, {
        error: 'storage_limit_reached',
        message:
          opts.quotaMessage ??
          `Your ${sub.tier} plan allows up to ${Math.round(storageLimit / 1024 / 1024)} MB of storage. This upload would exceed your quota.`,
        currentUsageBytes: usedBytes,
        uploadSizeBytes: buffer.length,
        limitBytes: storageLimit,
        tier: sub.tier,
      })
    }
  }

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
