import { describe, it, expect, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { ads, adCreatives, adReviews } from '../src/db/schema.js'
import { recordReview, resetReview } from '../src/ads/review.js'
import { resetDb } from './helpers/db.js'
import { createUser } from './helpers/factories.js'

async function makeAd(withCreative = true) {
  const [ad] = await db.insert(ads).values({ name: 'Ad', kind: 'partner', clickUrl: 'https://virvi.io' }).returning()
  if (withCreative) await db.insert(adCreatives).values({ adId: ad.id, shape: '16:9', kind: 'image', url: 'https://cdn.example/a.png' })
  return ad
}
const load = async (id: string) => (await db.select().from(ads).where(eq(ads.id, id)))[0]
const logOf = (id: string) => db.select().from(adReviews).where(eq(adReviews.adId, id))

describe('ad review', () => {
  beforeEach(async () => { await resetDb() })

  it('approving records the audience and the named reviewer, and logs it', async () => {
    const admin = await createUser({ role: 'admin' })
    const ad = await makeAd()
    expect(await recordReview(ad.id, { decision: 'approved', audience: 'mature' }, { kind: 'human', userId: admin.id })).toBe('ok')
    const row = await load(ad.id)
    expect(row.reviewStatus).toBe('approved')
    expect(row.audience).toBe('mature')
    expect(row.reviewerKind).toBe('human')
    expect(row.reviewedBy).toBe(admin.id)
    expect(row.reviewedAt).toBeInstanceOf(Date)
    const log = await logOf(ad.id)
    expect(log).toHaveLength(1)
    expect(log[0].decision).toBe('approved')
    expect(log[0].reviewerId).toBe(admin.id)
  })

  it('rejecting needs a reason and clears the audience', async () => {
    const admin = await createUser({ role: 'admin' })
    const by = { kind: 'human', userId: admin.id } as const
    const ad = await makeAd()
    expect(await recordReview(ad.id, { decision: 'rejected', reason: '  ' }, by)).toBe('bad_reason')
    expect(await recordReview(ad.id, { decision: 'rejected', reason: 'x'.repeat(501) }, by)).toBe('bad_reason')
    expect((await load(ad.id)).reviewStatus).toBe('pending')
    expect(await logOf(ad.id)).toHaveLength(0)
    await recordReview(ad.id, { decision: 'approved', audience: 'family' }, by)
    expect(await recordReview(ad.id, { decision: 'rejected', reason: 'Misleading claim' }, by)).toBe('ok')
    const row = await load(ad.id)
    expect(row.reviewStatus).toBe('rejected')
    expect(row.rejectReason).toBe('Misleading claim')
    expect(row.audience).toBeNull()
  })

  it('an ad with no creatives cannot be approved', async () => {
    const admin = await createUser({ role: 'admin' })
    const ad = await makeAd(false)
    expect(await recordReview(ad.id, { decision: 'approved', audience: 'family' }, { kind: 'human', userId: admin.id })).toBe('no_creatives')
    expect((await load(ad.id)).reviewStatus).toBe('pending')
  })

  it('an unknown ad is not found', async () => {
    const admin = await createUser({ role: 'admin' })
    expect(await recordReview(crypto.randomUUID(), { decision: 'approved', audience: 'family' }, { kind: 'human', userId: admin.id })).toBe('not_found')
  })

  it('an AI reviewer is recorded as the AI', async () => {
    const ad = await makeAd()
    expect(await recordReview(ad.id, { decision: 'approved', audience: 'family' }, { kind: 'ai', label: 'reviewer-v1' })).toBe('ok')
    const row = await load(ad.id)
    expect(row.reviewerKind).toBe('ai')
    expect(row.reviewedBy).toBeNull()
    const log = await logOf(ad.id)
    expect(log[0].reviewerKind).toBe('ai')
    expect(log[0].reviewerLabel).toBe('reviewer-v1')
  })

  it('resetReview returns an approved ad to pending and logs a system reset', async () => {
    const ad = await makeAd()
    await resetReview(ad.id)
    expect(await logOf(ad.id)).toHaveLength(0) // already pending: nothing to do
    await recordReview(ad.id, { decision: 'approved', audience: 'mature' }, { kind: 'ai', label: 'r' })
    const before = (await load(ad.id)).updatedAt
    await new Promise((r) => setTimeout(r, 20))
    await resetReview(ad.id)
    const row = await load(ad.id)
    expect(row.updatedAt.getTime()).toBeGreaterThan(before.getTime())
    expect(row.reviewStatus).toBe('pending')
    expect(row.audience).toBeNull()
    expect(row.rejectReason).toBeNull()
    expect(row.reviewerKind).toBeNull()
    expect(row.reviewedBy).toBeNull()
    expect(row.reviewedAt).toBeNull()
    const log = await logOf(ad.id)
    expect(log).toHaveLength(2)
    expect(log[1].decision).toBe('reset')
    expect(log[1].reviewerKind).toBe('system')
  })
})
