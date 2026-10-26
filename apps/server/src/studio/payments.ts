import { and, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import {
  studioDesigns, studioEntitlements, studioJobs, studioMistakeReports, studioPayments, studioPieces, studioPromptCredits,
  studioRevisions, type PaymentLine,
} from '../db/schema.js'
import { config } from '../config.js'
import { ensureCustomer, getStripe } from '../integrations/stripe.js'
import { priceLines, quoteFinalize, QuoteError } from './pricing.js'
import { startWorker, type Design } from './designs.js'
import type { Exec } from './quota.js'
import { publishStudio } from './events.js'

/**
 * Design Studio payments: one-time Stripe Checkout sessions for finalizing pieces and for prompt top-ups, applied once
 * from Stripe's webhook. A paid revision gets an entitlement, and the finalize job builds its package from the exact
 * files that were paid for.
 */

// Stripe refuses an expires_at under 30 minutes away, measured when it receives the request
const CHECKOUT_TTL_MS = 31 * 60 * 1000
export const FINALIZE_LIMITS = { timeoutSec: 1800, maxTurns: 0, costCeilingUsd: 0 }
export const REPORT_WINDOW_DAYS = 30
const PENDING_REPORT_MS = 10 * 60_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class PaymentError extends Error {
  constructor(public status: number, public code: string) { super(code) }
}

const appUrl = (path: string) => `${config.publicUrl.replace(/\/+$/, '')}${path}`
// An open session is reused only for exactly the same lines: revisions, what each costs, and which are waived
const lineKey = (lines: PaymentLine[]) =>
  lines.map((l) => `${l.revisionId}:${l.amountCents}:${l.waived ? 'w' : 'c'}`).sort().join(',')
const sameLines = (a: PaymentLine[], b: PaymentLine[]) => lineKey(a) === lineKey(b)

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
  const same = open.find((p) => p.stripeSessionUrl && sameLines(p.lines, lines))
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
 * Applies a paid payment once (a conditional update claims it): entitlements and their finalize jobs for a finalize,
 * credits for a top-up, all in one transaction, so a paid revision is never left without a job. Each line is priced
 * again against what is paid for by then (another checkout may have been paid first): an overcharge, and a line whose
 * revision was already paid for, are owed back, refunded after the commit and retried by the sweep until Stripe
 * confirms.
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
      return { pay, jobIds: [] as string[] }
    }
    // Grants for one design run one at a time, so each prices against the others
    const [design] = await tx.select().from(studioDesigns).where(eq(studioDesigns.id, pay.designId!)).for('update')
    const earlier = await tx.select({ category: studioEntitlements.category, revisionId: studioEntitlements.revisionId })
      .from(studioEntitlements).where(eq(studioEntitlements.designId, design.id))
    const fresh = pay.lines.filter((l) => !earlier.some((e) => e.revisionId === l.revisionId))
    const repriced = priceLines(design.kind, fresh.map((l) => ({
      kind: earlier.some((e) => e.category === l.category) ? 'revision' as const : 'first' as const,
    })), earlier.length > 0)
    let owed = pay.lines.filter((l) => !fresh.includes(l) && !l.waived).reduce((sum, l) => sum + l.amountCents, 0)
    const entitlementIds: string[] = []
    for (const [i, l] of fresh.entries()) {
      const price = repriced[i]
      const charged = l.waived ? 0 : Math.min(l.amountCents, price.amountCents)
      if (!l.waived) owed += l.amountCents - charged
      const [e] = await tx.insert(studioEntitlements).values({
        revisionId: l.revisionId, paymentId: pay.id, userId: pay.userId, designId: design.id, category: l.category,
        kind: price.priceKind.startsWith('revision') ? 'revision' : 'first', amountCents: charged, status: 'packaging',
      }).returning()
      entitlementIds.push(e.id)
      if (l.waived) {
        await tx.insert(studioMistakeReports).values({
          entitlementId: e.id, userId: pay.userId, text: l.reportText ?? '', refundCents: l.amountCents, status: 'waived',
        })
      }
    }
    if (owed > 0) await tx.update(studioPayments).set({ refundDueCents: owed }).where(eq(studioPayments.id, pay.id))
    if (entitlementIds.length) {
      await tx.update(studioDesigns).set({ finalizedAt: now })
        .where(and(eq(studioDesigns.id, design.id), isNull(studioDesigns.finalizedAt)))
    }
    return { pay, jobIds: await insertFinalizeJobs(tx, design, entitlementIds, now) }
  })
  if (!out) return 'already'
  await settleRefund(out.pay.id)
  await startFinalizeJobs(out.pay.designId, out.jobIds, now)
  return 'granted'
}

/** One finalize job per entitlement, each building one paid revision's package from that revision's own files. */
async function insertFinalizeJobs(tx: Exec, design: Design, entitlementIds: string[], now: Date): Promise<string[]> {
  if (!entitlementIds.length) return []
  const rows = await tx.select({ e: studioEntitlements, r: studioRevisions, name: studioPieces.name })
    .from(studioEntitlements)
    .innerJoin(studioRevisions, eq(studioRevisions.id, studioEntitlements.revisionId))
    .innerJoin(studioPieces, eq(studioPieces.id, studioRevisions.pieceId))
    .where(inArray(studioEntitlements.id, entitlementIds))
  const jobIds: string[] = []
  for (const { e, r, name } of rows) {
    const [job] = await tx.insert(studioJobs).values({
      designId: design.id,
      type: 'finalize',
      payload: {
        type: 'finalize', kind: design.kind, agent: null, model: null, prompt: null, selectedSlots: null,
        limits: FINALIZE_LIMITS, render: null,
        finalize: {
          designName: design.name,
          pieces: [{ category: e.category, name, revision: r.number, files: r.files, sourceJobId: r.jobId }],
        },
      },
    }).returning({ id: studioJobs.id })
    await tx.update(studioEntitlements).set({ status: 'packaging', jobId: job.id }).where(eq(studioEntitlements.id, e.id))
    jobIds.push(job.id)
  }
  await tx.update(studioDesigns).set({ lastJobAt: now }).where(eq(studioDesigns.id, design.id))
  return jobIds
}

async function startFinalizeJobs(designId: string | null, jobIds: string[], now: Date): Promise<void> {
  if (!designId || !jobIds.length) return
  for (const jobId of jobIds) await publishStudio(designId, { type: 'job', jobId, status: 'queued' })
  await startWorker(designId, jobIds[0], now)
}

/** Queues packaging again for these entitlements (a free retry, or the sweep finding one with no live job). */
export async function queueFinalize(designId: string, entitlementIds: string[], now: Date): Promise<string[]> {
  const jobIds = await db.transaction(async (tx) => {
    const [design] = await tx.select().from(studioDesigns).where(eq(studioDesigns.id, designId)).for('update')
    return insertFinalizeJobs(tx, design, entitlementIds, now)
  })
  await startFinalizeJobs(designId, jobIds, now)
  return jobIds
}

/**
 * Pays back what a payment owes (refundDueCents) through Stripe. A refund Stripe already made for it (an answer that
 * was lost) is recorded rather than repeated; a failed attempt counts up, and its key with it, because Stripe replays
 * a key's first answer, errors included.
 */
export async function settleRefund(paymentId: string): Promise<void> {
  const [pay] = await db.select().from(studioPayments).where(eq(studioPayments.id, paymentId))
  if (!pay || !(pay.refundDueCents > 0)) return
  if (!pay.stripePaymentIntent) {
    console.error(`[studio] payment ${pay.id} owes ${pay.refundDueCents} cents but has no payment intent to refund`)
    return
  }
  const due = pay.refundDueCents
  try {
    const stripe = await getStripe()
    const made = (await stripe.refunds.list({ payment_intent: pay.stripePaymentIntent, limit: 100 })).data as { metadata?: Record<string, string> }[]
    if (!made.some((r) => r.metadata?.vlm_studio_owed_by === pay.id)) {
      await stripe.refunds.create(
        { payment_intent: pay.stripePaymentIntent, amount: due, metadata: { vlm_studio_payment_id: pay.id, vlm_studio_owed_by: pay.id } },
        { idempotencyKey: `studio-refund-${pay.id}-${pay.refundAttempts}` },
      )
    }
    await db.update(studioPayments)
      .set({ refundDueCents: 0, refundedCents: sql`${studioPayments.refundedCents} + ${due}` })
      .where(and(eq(studioPayments.id, pay.id), eq(studioPayments.refundDueCents, due)))
  } catch (err) {
    console.error(`[studio] refund of ${due} cents for payment ${pay.id} failed:`, err instanceof Error ? err.message : err)
    await db.update(studioPayments).set({ refundAttempts: sql`${studioPayments.refundAttempts} + 1` }).where(eq(studioPayments.id, pay.id))
  }
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

/**
 * The customer says a paid revision fixed the agent's own mistake: its line is refunded in full through Stripe, at
 * once and without review (VLM reviews the log afterwards). A pending report row is the lock, so two clicks refund
 * once; a refund Stripe already made for this entitlement (an answer that was lost) is recorded, not repeated; a
 * refused refund removes the row so the customer can try again, under a new key (Stripe replays a key's first
 * answer, errors included).
 */
export async function reportMistake(
  design: Design,
  category: string,
  revisionNumber: number,
  text: string,
  now: Date,
): Promise<{ status: 'refunded'; refundCents: number }> {
  const [row] = await db.select({ e: studioEntitlements, pay: studioPayments })
    .from(studioEntitlements)
    .innerJoin(studioRevisions, eq(studioRevisions.id, studioEntitlements.revisionId))
    .innerJoin(studioPieces, eq(studioPieces.id, studioRevisions.pieceId))
    .innerJoin(studioPayments, eq(studioPayments.id, studioEntitlements.paymentId))
    .where(and(eq(studioPieces.designId, design.id), eq(studioPieces.category, category), eq(studioRevisions.number, revisionNumber)))
  if (!row) throw new PaymentError(402, 'not_paid')
  const { e, pay } = row
  if (e.kind !== 'revision') throw new PaymentError(409, 'not_a_revision')
  if (!(e.amountCents > 0) || !pay.stripePaymentIntent) throw new PaymentError(409, 'nothing_charged')
  if (!pay.paidAt || now.getTime() - pay.paidAt.getTime() > REPORT_WINDOW_DAYS * 24 * 3600 * 1000) {
    throw new PaymentError(409, 'report_window_closed')
  }
  // A pending row left by a request that died mid-refund stops being a lock after a while
  await db.delete(studioMistakeReports).where(and(
    eq(studioMistakeReports.entitlementId, e.id), eq(studioMistakeReports.status, 'pending'),
    lt(studioMistakeReports.createdAt, new Date(now.getTime() - PENDING_REPORT_MS)),
  ))
  const [lock] = await db.insert(studioMistakeReports).values({
    entitlementId: e.id, userId: e.userId, text, refundCents: e.amountCents, status: 'pending', createdAt: now,
  }).onConflictDoNothing().returning()
  if (!lock) throw new PaymentError(409, 'already_reported')
  let refundId: string
  try {
    const stripe = await getStripe()
    const made = (await stripe.refunds.list({ payment_intent: pay.stripePaymentIntent, limit: 100 })).data as { id: string; metadata?: Record<string, string> }[]
    const earlier = made.find((r) => r.metadata?.vlm_studio_entitlement_id === e.id)
    refundId = earlier?.id ?? (await stripe.refunds.create(
      { payment_intent: pay.stripePaymentIntent, amount: e.amountCents, metadata: { vlm_studio_entitlement_id: e.id, reason: 'agent_mistake' } },
      { idempotencyKey: `studio-report-${e.id}-${lock.id}` },
    )).id
  } catch (err) {
    console.error('[studio] mistake refund failed:', err instanceof Error ? err.message : err)
    await db.delete(studioMistakeReports).where(eq(studioMistakeReports.id, lock.id))
    throw new PaymentError(502, 'stripe_error')
  }
  await db.transaction(async (tx) => {
    await tx.update(studioMistakeReports).set({ status: 'refunded', stripeRefundId: refundId }).where(eq(studioMistakeReports.id, lock.id))
    await tx.update(studioPayments).set({ refundedCents: sql`${studioPayments.refundedCents} + ${e.amountCents}` })
      .where(eq(studioPayments.id, pay.id))
  })
  return { status: 'refunded', refundCents: e.amountCents }
}

/** A design's paid revision of one piece, by revision number, with the piece's name; null when it wasn't paid for. */
export async function entitlementFor(designId: string, category: string, revisionNumber: number) {
  const [row] = await db.select({ e: studioEntitlements, name: studioPieces.name })
    .from(studioEntitlements)
    .innerJoin(studioRevisions, eq(studioRevisions.id, studioEntitlements.revisionId))
    .innerJoin(studioPieces, eq(studioPieces.id, studioRevisions.pieceId))
    .where(and(eq(studioPieces.designId, designId), eq(studioPieces.category, category), eq(studioRevisions.number, revisionNumber)))
  return row ?? null
}

/** Every paid revision of a design, newest first, as the page lists them (never the package's location). */
export async function finalizedRevisions(designId: string) {
  const rows = await db.select({
    e: studioEntitlements, number: studioRevisions.number, paidAt: studioPayments.paidAt,
    reportStatus: studioMistakeReports.status, reportedAt: studioMistakeReports.createdAt,
  })
    .from(studioEntitlements)
    .innerJoin(studioRevisions, eq(studioRevisions.id, studioEntitlements.revisionId))
    .innerJoin(studioPayments, eq(studioPayments.id, studioEntitlements.paymentId))
    .leftJoin(studioMistakeReports, eq(studioMistakeReports.entitlementId, studioEntitlements.id))
    .where(eq(studioEntitlements.designId, designId))
  return rows
    .sort((a, b) => b.number - a.number)
    .map((r) => ({
      category: r.e.category,
      revision: r.number,
      kind: r.e.kind,
      status: r.e.status,
      amountCents: r.e.amountCents,
      paidAt: r.paidAt,
      report: r.reportStatus ? { status: r.reportStatus, createdAt: r.reportedAt } : null,
      reportableUntil: r.e.kind === 'revision' && r.e.amountCents > 0 && !r.reportStatus && r.paidAt
        ? new Date(r.paidAt.getTime() + REPORT_WINDOW_DAYS * 24 * 3600 * 1000)
        : null,
    }))
}
