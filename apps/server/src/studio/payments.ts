import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import {
  studioDesigns, studioEntitlements, studioJobs, studioMistakeReports, studioPayments, studioPieces, studioPromptCredits,
  studioRevisions, type PaymentLine,
} from '../db/schema.js'
import { config } from '../config.js'
import { ensureCustomer, getStripe } from '../integrations/stripe.js'
import { quoteFinalize, QuoteError } from './pricing.js'
import { startWorker, type Design } from './designs.js'
import { publishStudio } from './events.js'

/**
 * Design Studio payments: one-time Stripe Checkout sessions for finalizing pieces and for prompt top-ups, applied once
 * from Stripe's webhook. A paid revision gets an entitlement, and the finalize job builds its package from the exact
 * files that were paid for.
 */

// Stripe refuses an expires_at under 30 minutes away, measured when it receives the request
const CHECKOUT_TTL_MS = 31 * 60 * 1000
export const FINALIZE_LIMITS = { timeoutSec: 1800, maxTurns: 0, costCeilingUsd: 0 }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class PaymentError extends Error {
  constructor(public status: number, public code: string) { super(code) }
}

const appUrl = (path: string) => `${config.publicUrl.replace(/\/+$/, '')}${path}`
const sameRevisions = (a: PaymentLine[], b: PaymentLine[]) =>
  a.map((l) => l.revisionId).sort().join(',') === b.map((l) => l.revisionId).sort().join(',')

function lineName(l: PaymentLine): string {
  return l.priceKind.startsWith('revision') ? `${l.pieceName}: revision ${l.revisionNumber}` : `${l.pieceName}: finalize`
}

async function openSession(params: Record<string, unknown>, paymentId: string): Promise<string> {
  try {
    const session = await (await getStripe()).checkout.sessions.create(params)
    await db.update(studioPayments).set({ stripeSessionId: session.id, stripeSessionUrl: session.url }).where(eq(studioPayments.id, paymentId))
    return session.url
  } catch (err) {
    console.error('[studio] checkout session failed:', err instanceof Error ? err.message : err)
    await db.delete(studioPayments).where(eq(studioPayments.id, paymentId))
    throw new PaymentError(502, 'stripe_error')
  }
}

export async function createFinalizeCheckout(
  design: Design,
  user: { id: string; email: string | null },
  categories: string[] | null,
  reports: Record<string, string>,
  now: Date,
): Promise<{ url: string } | { granted: true; paymentId: string }> {
  const quote = await quoteFinalize(design, categories, Object.keys(reports))
  if (!quote.lines.length) throw new QuoteError('nothing_to_pay', categories ?? [])
  const lines = quote.lines.map((l) => (l.waived ? { ...l, reportText: reports[l.category] } : l))
  if (quote.totalCents === 0) {
    const [pay] = await db.insert(studioPayments).values({ userId: user.id, designId: design.id, kind: 'finalize', amountCents: 0, lines }).returning()
    await grantPayment(pay.id, null, now)
    return { granted: true, paymentId: pay.id }
  }
  const open = await db.select().from(studioPayments).where(and(
    eq(studioPayments.designId, design.id), eq(studioPayments.status, 'pending'), gt(studioPayments.expiresAt, now),
  ))
  const same = open.find((p) => p.stripeSessionUrl && sameRevisions(p.lines, lines))
  if (same) return { url: same.stripeSessionUrl! }

  const expiresAt = new Date(now.getTime() + CHECKOUT_TTL_MS)
  const [pay] = await db.insert(studioPayments).values({
    userId: user.id, designId: design.id, kind: 'finalize', amountCents: quote.totalCents, lines, expiresAt,
  }).returning()
  let customer: string
  try {
    customer = await ensureCustomer(user.id, user.email)
  } catch (err) {
    console.error('[studio] stripe customer failed:', err instanceof Error ? err.message : err)
    await db.delete(studioPayments).where(eq(studioPayments.id, pay.id))
    throw new PaymentError(502, 'stripe_error')
  }
  const metadata = { vlm_user_id: user.id, vlm_studio_payment_id: pay.id }
  const url = await openSession({
    mode: 'payment',
    customer,
    line_items: lines.filter((l) => !l.waived).map((l) => ({
      quantity: 1,
      price_data: { currency: 'usd', unit_amount: l.amountCents, product_data: { name: lineName(l) } },
    })),
    metadata,
    payment_intent_data: { metadata },
    success_url: appUrl(`/studio/${design.id}?payment=${pay.id}`),
    cancel_url: appUrl(`/studio/${design.id}`),
    expires_at: Math.floor(expiresAt.getTime() / 1000),
  }, pay.id)
  return { url }
}

export async function createTopupCheckout(user: { id: string; email: string | null }, packs: number, now: Date): Promise<{ url: string }> {
  const { topupCents, topupPrompts } = config.studioPrices
  const expiresAt = new Date(now.getTime() + CHECKOUT_TTL_MS)
  const [pay] = await db.insert(studioPayments).values({
    userId: user.id, kind: 'topup', amountCents: topupCents * packs, prompts: topupPrompts * packs, expiresAt,
  }).returning()
  let customer: string
  try {
    customer = await ensureCustomer(user.id, user.email)
  } catch (err) {
    console.error('[studio] stripe customer failed:', err instanceof Error ? err.message : err)
    await db.delete(studioPayments).where(eq(studioPayments.id, pay.id))
    throw new PaymentError(502, 'stripe_error')
  }
  const metadata = { vlm_user_id: user.id, vlm_studio_payment_id: pay.id }
  const url = await openSession({
    mode: 'payment',
    customer,
    line_items: [{ quantity: packs, price_data: { currency: 'usd', unit_amount: topupCents, product_data: { name: `${topupPrompts} Design Studio prompts` } } }],
    metadata,
    payment_intent_data: { metadata },
    success_url: appUrl(`/studio?payment=${pay.id}`),
    cancel_url: appUrl('/studio'),
    expires_at: Math.floor(expiresAt.getTime() / 1000),
  }, pay.id)
  return { url }
}

/**
 * Applies a paid payment once (a conditional update claims it): entitlements for a finalize, credits for a top-up. A
 * line whose revision was already paid for is refunded; the new entitlements are queued for packaging.
 */
export async function grantPayment(paymentId: string, paymentIntent: string | null, now: Date): Promise<'granted' | 'already'> {
  const out = await db.transaction(async (tx) => {
    const [pay] = await tx.update(studioPayments)
      .set({ status: 'paid', paidAt: now, ...(paymentIntent ? { stripePaymentIntent: paymentIntent } : {}) })
      .where(and(eq(studioPayments.id, paymentId), eq(studioPayments.status, 'pending')))
      .returning()
    if (!pay) return null
    if (pay.kind === 'topup') {
      await tx.insert(studioPromptCredits).values({ userId: pay.userId, balance: pay.prompts })
        .onConflictDoUpdate({ target: studioPromptCredits.userId, set: { balance: sql`${studioPromptCredits.balance} + ${pay.prompts}`, updatedAt: now } })
      return { pay, entitlementIds: [] as string[], duplicateCents: 0 }
    }
    const entitlementIds: string[] = []
    let duplicateCents = 0
    for (const l of pay.lines) {
      const [e] = await tx.insert(studioEntitlements).values({
        revisionId: l.revisionId, paymentId: pay.id, userId: pay.userId, designId: pay.designId!, category: l.category,
        kind: l.priceKind.startsWith('revision') ? 'revision' : 'first', amountCents: l.waived ? 0 : l.amountCents, status: 'packaging',
      }).onConflictDoNothing().returning()
      if (!e) {
        if (!l.waived) duplicateCents += l.amountCents
        continue
      }
      entitlementIds.push(e.id)
      if (l.waived) {
        await tx.insert(studioMistakeReports).values({
          entitlementId: e.id, userId: pay.userId, text: l.reportText ?? '', refundCents: l.amountCents, status: 'waived',
        })
      }
    }
    if (entitlementIds.length) {
      await tx.update(studioDesigns).set({ finalizedAt: now })
        .where(and(eq(studioDesigns.id, pay.designId!), isNull(studioDesigns.finalizedAt)))
    }
    return { pay, entitlementIds, duplicateCents }
  })
  if (!out) return 'already'
  if (out.duplicateCents > 0 && out.pay.stripePaymentIntent) {
    try {
      await (await getStripe()).refunds.create(
        { payment_intent: out.pay.stripePaymentIntent, amount: out.duplicateCents, metadata: { vlm_studio_payment_id: out.pay.id, reason: 'duplicate' } },
        { idempotencyKey: `studio-dup-${out.pay.id}` },
      )
      await db.update(studioPayments).set({ refundedCents: sql`${studioPayments.refundedCents} + ${out.duplicateCents}` })
        .where(eq(studioPayments.id, out.pay.id))
    } catch (err) {
      console.error(`[studio] duplicate payment ${out.pay.id} was not refunded:`, err instanceof Error ? err.message : err)
    }
  }
  if (out.entitlementIds.length) await queueFinalize(out.pay.designId!, out.entitlementIds, now)
  return 'granted'
}

/** Queues one finalize job for these entitlements: the package is built from each paid revision's own files. */
export async function queueFinalize(designId: string, entitlementIds: string[], now: Date): Promise<string> {
  const jobId = await db.transaction(async (tx) => {
    const [d] = await tx.select().from(studioDesigns).where(eq(studioDesigns.id, designId)).for('update')
    const rows = await tx.select({ e: studioEntitlements, r: studioRevisions, name: studioPieces.name })
      .from(studioEntitlements)
      .innerJoin(studioRevisions, eq(studioRevisions.id, studioEntitlements.revisionId))
      .innerJoin(studioPieces, eq(studioPieces.id, studioRevisions.pieceId))
      .where(inArray(studioEntitlements.id, entitlementIds))
    const [job] = await tx.insert(studioJobs).values({
      designId,
      type: 'finalize',
      payload: {
        type: 'finalize', kind: d.kind, agent: null, model: null, prompt: null, selectedSlots: null,
        limits: FINALIZE_LIMITS, render: null,
        finalize: {
          designName: d.name,
          pieces: rows.map(({ e, r, name }) => ({ category: e.category, name, revision: r.number, files: r.files, sourceJobId: r.jobId })),
        },
      },
    }).returning({ id: studioJobs.id })
    await tx.update(studioEntitlements).set({ status: 'packaging', jobId: job.id }).where(inArray(studioEntitlements.id, entitlementIds))
    await tx.update(studioDesigns).set({ lastJobAt: now }).where(eq(studioDesigns.id, designId))
    return job.id
  })
  await publishStudio(designId, { type: 'job', jobId, status: 'queued' })
  await startWorker(designId, jobId, now)
  return jobId
}

/** A Stripe Checkout event for a studio payment; false when the event isn't one. */
export async function handleStudioSession(event: { type: string; data?: { object?: any } }): Promise<boolean> {
  const s = event.data?.object
  const id = s?.metadata?.vlm_studio_payment_id
  if (!id || s?.object !== 'checkout.session' || s.mode !== 'payment') return false
  if (typeof id !== 'string' || !UUID.test(id)) return true
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    if (s.payment_status === 'paid') await grantPayment(id, typeof s.payment_intent === 'string' ? s.payment_intent : null, new Date())
  } else if (event.type === 'checkout.session.expired') {
    await db.update(studioPayments).set({ status: 'expired' }).where(and(eq(studioPayments.id, id), eq(studioPayments.status, 'pending')))
  }
  return true
}
