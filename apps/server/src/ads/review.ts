import { eq, sql } from 'drizzle-orm'
import type { AdAudience, AdReviewer } from '@virvixr/shared'
import { db } from '../db/connection.js'
import { ads, adCreatives, adReviews } from '../db/schema.js'

export const MAX_REASON_LENGTH = 500

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

export type ReviewDecision = { decision: 'approved'; audience: AdAudience } | { decision: 'rejected'; reason: string }

/** Records a reviewer's decision on an ad and appends it to the review log, in one transaction. */
export async function recordReview(
  adId: string,
  d: ReviewDecision,
  by: AdReviewer,
): Promise<'ok' | 'not_found' | 'no_creatives' | 'bad_reason'> {
  const reason = d.decision === 'rejected' ? d.reason.trim() : null
  if (d.decision === 'rejected' && (!reason || reason.length > MAX_REASON_LENGTH)) return 'bad_reason'

  return db.transaction(async (tx) => {
    const [ad] = await tx.select({ id: ads.id }).from(ads).where(eq(ads.id, adId)).for('update')
    if (!ad) return 'not_found' as const
    if (d.decision === 'approved') {
      const [c] = await tx.select({ id: adCreatives.id }).from(adCreatives).where(eq(adCreatives.adId, adId)).limit(1)
      if (!c) return 'no_creatives' as const
    }
    const audience = d.decision === 'approved' ? d.audience : null
    const reviewerId = by.kind === 'human' ? by.userId : null
    const now = new Date()
    await tx.update(ads).set({
      reviewStatus: d.decision,
      audience,
      rejectReason: reason,
      reviewerKind: by.kind,
      reviewedBy: reviewerId,
      reviewedAt: now,
      updatedAt: now,
    }).where(eq(ads.id, adId))
    await tx.insert(adReviews).values({
      adId,
      decision: d.decision,
      audience,
      reason,
      reviewerKind: by.kind,
      reviewerId,
      reviewerLabel: by.kind === 'ai' ? by.label : null,
    })
    return 'ok' as const
  })
}

/** Returns an ad to pending (its content changed) and logs a system reset. Does nothing if it is already pending. */
export async function resetReview(adId: string, tx?: Tx): Promise<void> {
  if (!tx) return db.transaction((t) => resetReview(adId, t))
  const reset = await tx.update(ads).set({
    reviewStatus: 'pending',
    audience: null,
    rejectReason: null,
    reviewerKind: null,
    reviewedBy: null,
    reviewedAt: null,
    updatedAt: new Date(),
  }).where(sql`${ads.id} = ${adId} AND ${ads.reviewStatus} <> 'pending'`).returning({ id: ads.id })
  if (!reset.length) return
  await tx.insert(adReviews).values({ adId, decision: 'reset', reviewerKind: 'system' })
}
