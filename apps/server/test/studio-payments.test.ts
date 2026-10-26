import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import Stripe from 'stripe'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import {
  studioDesigns, studioEntitlements, studioJobs, studioMistakeReports, studioPayments, studioPromptCredits, subscriptions,
} from '../src/db/schema.js'
import { config } from '../src/config.js'
import { setStripe } from '../src/integrations/stripe.js'
import { memoryStudioStore, setStudioStore } from '../src/studio/store.js'
import { setMachineDeps } from '../src/studio/machines.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor, type TestUser } from './helpers/factories.js'
import { createDesign, addRevision, entitle, fakeFly, fakeStripe } from './helpers/studio.js'

const WEBHOOK_SECRET = 'whsec_studio_test'
const signer = new Stripe('sk_test_dummy')

describe('studio payments', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let stripe: ReturnType<typeof fakeStripe>
  let fly: ReturnType<typeof fakeFly>
  const prev = {
    enabled: config.studioEnabled, key: config.stripeSecretKey, billing: config.billingEnabled,
    secret: config.stripeWebhookSecret, image: config.studioWorkerImage,
  }
  beforeAll(() => {
    ;(config as any).studioEnabled = true
    ;(config as any).studioWorkerImage = 'registry.fly.io/vlm-studio-worker:test'
    ;(config as any).stripeSecretKey = 'sk_test_studio'
    ;(config as any).billingEnabled = true
    ;(config as any).stripeWebhookSecret = WEBHOOK_SECRET
  })
  afterAll(() => {
    ;(config as any).studioEnabled = prev.enabled
    ;(config as any).studioWorkerImage = prev.image
    ;(config as any).stripeSecretKey = prev.key
    ;(config as any).billingEnabled = prev.billing
    ;(config as any).stripeWebhookSecret = prev.secret
    setStripe(null)
    setMachineDeps(null)
    setStudioStore(null)
  })
  beforeEach(async () => {
    await resetDb()
    stripe = fakeStripe()
    setStripe(stripe)
    fly = fakeFly()
    setMachineDeps({ fly })
    setStudioStore(memoryStudioStore())
    app = await testApp()
  })

  const as = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })
  const finalize = (u: TestUser, id: string, payload: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url: `/api/studio/designs/${id}/finalize`, headers: as(u), payload })
  async function webhook(type: string, object: Record<string, unknown>) {
    const payload = JSON.stringify({ id: `evt_${Math.random()}`, object: 'event', type, data: { object } })
    const res = await app.inject({
      method: 'POST',
      url: '/api/billing/webhook',
      headers: { 'content-type': 'application/json', 'stripe-signature': signer.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET }) },
      payload,
    })
    expect(res.statusCode).toBe(200)
  }
  const paid = (paymentId: string, intent = 'pi_1') => webhook('checkout.session.completed', {
    id: 'cs_x', object: 'checkout.session', mode: 'payment', payment_status: 'paid', payment_intent: intent,
    metadata: { vlm_studio_payment_id: paymentId, vlm_user_id: 'x' },
  })
  const paymentOf = async (designId: string) => db.select().from(studioPayments).where(eq(studioPayments.designId, designId))

  it('checkout opens one Stripe session at the quoted price', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    await addRevision(d, 'hat')
    const before = Date.now()
    const res = await finalize(u, d.id)
    expect(res.statusCode).toBe(200)
    expect(res.json().url).toBe('https://checkout.stripe.test/2')
    expect(stripe.calls.sessions).toHaveLength(1)
    const s = stripe.calls.sessions[0]
    const [pay] = await paymentOf(d.id)
    expect(pay).toMatchObject({ status: 'pending', kind: 'finalize', amountCents: 2900, stripeSessionId: 'cs_test_2' })
    expect(s.mode).toBe('payment')
    expect(s.line_items.map((l: any) => l.price_data.unit_amount)).toEqual([2900])
    expect(s.line_items[0].price_data.currency).toBe('usd')
    expect(s.metadata).toEqual({ vlm_user_id: u.id, vlm_studio_payment_id: pay.id })
    expect(s.payment_intent_data.metadata).toEqual({ vlm_user_id: u.id, vlm_studio_payment_id: pay.id })
    expect(new URL(s.success_url).pathname + new URL(s.success_url).search).toBe(`/studio/${d.id}?payment=${pay.id}`)
    expect(new URL(s.cancel_url).pathname + new URL(s.cancel_url).search).toBe(`/studio/${d.id}`)
    // Stripe's minimum is 30 minutes from when it receives the request, so the session asks for 31
    expect(s.expires_at * 1000 - before).toBeGreaterThan(1850_000)
    expect(s.expires_at * 1000 - before).toBeLessThan(1870_000)
  })

  it('a second click reuses the open session', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    await addRevision(d, 'hat')
    const a = (await finalize(u, d.id)).json().url
    const b = (await finalize(u, d.id)).json().url
    expect(b).toBe(a)
    expect(stripe.calls.sessions).toHaveLength(1)
    expect(await paymentOf(d.id)).toHaveLength(1)
  })

  it('the paid webhook grants entitlements and queues one finalize job', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    await addRevision(d, 'hat')
    await finalize(u, d.id)
    const [pay] = await paymentOf(d.id)
    await paid(pay.id)
    const ents = await db.select().from(studioEntitlements)
    expect(ents).toHaveLength(1)
    expect(ents[0]).toMatchObject({ category: 'hat', kind: 'first', amountCents: 2900, status: 'packaging', paymentId: pay.id })
    const jobs = await db.select().from(studioJobs).where(eq(studioJobs.type, 'finalize'))
    expect(jobs).toHaveLength(1)
    expect(ents[0].jobId).toBe(jobs[0].id)
    const [after] = await paymentOf(d.id)
    expect(after).toMatchObject({ status: 'paid', stripePaymentIntent: 'pi_1' })
    const [design] = await db.select().from(studioDesigns).where(eq(studioDesigns.id, d.id))
    expect(design.finalizedAt).not.toBeNull()
    expect(fly.calls.create.length + fly.calls.start.length).toBeGreaterThan(0)
  })

  it('the same webhook twice changes nothing', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    await addRevision(d, 'hat')
    await finalize(u, d.id)
    const [pay] = await paymentOf(d.id)
    await paid(pay.id)
    await paid(pay.id)
    expect(await db.select().from(studioEntitlements)).toHaveLength(1)
    expect(await db.select().from(studioJobs).where(eq(studioJobs.type, 'finalize'))).toHaveLength(1)
    expect(stripe.calls.refunds).toHaveLength(0)
  })

  it('duplicate payment for an entitled revision is refunded', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    await addRevision(d, 'hat')
    await finalize(u, d.id)
    const [first] = await paymentOf(d.id)
    // the first session lapses on the client's side; a second one is opened and both end up paid
    await db.update(studioPayments).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(studioPayments.id, first.id))
    await finalize(u, d.id)
    const second = (await paymentOf(d.id)).find((p) => p.id !== first.id)!
    expect(stripe.calls.sessions).toHaveLength(2)
    await paid(first.id, 'pi_first')
    await paid(second.id, 'pi_second')
    expect(await db.select().from(studioEntitlements)).toHaveLength(1)
    expect(stripe.calls.refunds).toEqual([{
      params: expect.objectContaining({ payment_intent: 'pi_second', amount: 2900 }),
      opts: { idempotencyKey: `studio-dup-${second.id}` },
    }])
    const [after] = await db.select().from(studioPayments).where(eq(studioPayments.id, second.id))
    expect(after.refundedCents).toBe(2900)
  })

  it('an expired session expires its payment', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    await addRevision(d, 'hat')
    await finalize(u, d.id)
    const [pay] = await paymentOf(d.id)
    await webhook('checkout.session.expired', { id: 'cs_x', object: 'checkout.session', mode: 'payment', payment_status: 'unpaid', metadata: { vlm_studio_payment_id: pay.id } })
    expect((await paymentOf(d.id))[0].status).toBe('expired')
    expect(await db.select().from(studioEntitlements)).toHaveLength(0)
  })

  it('a fully waived checkout grants at once', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    await entitle(d, await addRevision(d, 'hat'))
    const rev2 = await addRevision(d, 'hat')
    const res = await finalize(u, d.id, { reports: { hat: 'the brim clipped through the hair when waving' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ granted: true })
    expect(stripe.calls.sessions).toHaveLength(0)
    const [ent] = await db.select().from(studioEntitlements).where(eq(studioEntitlements.revisionId, rev2.id))
    expect(ent).toMatchObject({ kind: 'revision', amountCents: 0, status: 'packaging' })
    const [report] = await db.select().from(studioMistakeReports).where(eq(studioMistakeReports.entitlementId, ent.id))
    expect(report).toMatchObject({ status: 'waived', refundCents: 1500, text: 'the brim clipped through the hair when waving' })
  })

  it("a blocked piece can't be bought", async () => {
    const u = await createUser()
    const d = await createDesign(u)
    await addRevision(d, 'hat', { pass: false, failures: 1, warnings: 0 })
    const res = await finalize(u, d.id, { categories: ['hat'] })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'checks_failed', categories: ['hat'] })
    expect(await paymentOf(d.id)).toHaveLength(0)
  })

  it('a top-up adds credits when paid', async () => {
    const u = await createUser()
    const res = await app.inject({ method: 'POST', url: '/api/studio/topups', headers: as(u), payload: { packs: 2 } })
    expect(res.statusCode).toBe(200)
    const s = stripe.calls.sessions[0]
    expect(s.line_items).toEqual([expect.objectContaining({ quantity: 2, price_data: expect.objectContaining({ unit_amount: 500 }) })])
    expect(new URL(s.success_url).search).toMatch(/^\?payment=/)
    const [pay] = await db.select().from(studioPayments).where(eq(studioPayments.userId, u.id))
    expect(pay).toMatchObject({ kind: 'topup', prompts: 20, amountCents: 1000, designId: null })
    await paid(pay.id)
    const [credits] = await db.select().from(studioPromptCredits).where(eq(studioPromptCredits.userId, u.id))
    expect(credits.balance).toBe(20)
    expect((await app.inject({ method: 'POST', url: '/api/studio/topups', headers: as(u), payload: { packs: 11 } })).statusCode).toBe(400)
  })

  it('without Stripe the routes answer 503', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    await addRevision(d, 'hat')
    ;(config as any).stripeSecretKey = undefined
    try {
      const a = await finalize(u, d.id)
      expect(a.statusCode).toBe(503)
      expect(a.json().code).toBe('payments_unavailable')
      expect((await app.inject({ method: 'POST', url: '/api/studio/topups', headers: as(u), payload: {} })).statusCode).toBe(503)
    } finally {
      ;(config as any).stripeSecretKey = 'sk_test_studio'
    }
  })

  it('a failed Stripe call leaves no payment behind', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    await addRevision(d, 'hat')
    stripe.failSessions = true
    const res = await finalize(u, d.id)
    expect(res.statusCode).toBe(502)
    expect(res.json().code).toBe('stripe_error')
    expect(await paymentOf(d.id)).toHaveLength(0)
  })

  it('subscription checkouts still activate a subscription', async () => {
    const u = await createUser()
    await db.insert(subscriptions).values({ userId: u.id, stripeCustomerId: 'cus_s', tier: 'free', status: 'active' })
    await webhook('checkout.session.completed', {
      id: 'cs_sub', object: 'checkout.session', mode: 'subscription', subscription: 'sub_1', customer: 'cus_s',
      metadata: { vlm_user_id: u.id },
    })
    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.userId, u.id))
    expect(sub).toMatchObject({ stripeSubscriptionId: 'sub_1', status: 'active' })
  })

  describe('mistake reports', () => {
    const report = (u: TestUser, id: string, category: string, n: number, text = 'the sleeve clips through the arm when waving') =>
      app.inject({ method: 'POST', url: `/api/studio/designs/${id}/pieces/${category}/revisions/${n}/report`, headers: as(u), payload: { text } })

    async function revised(u: TestUser, opts: { paidAt?: Date } = {}) {
      const d = await createDesign(u)
      await entitle(d, await addRevision(d, 'hat'))
      await entitle(d, await addRevision(d, 'feet'))
      await addRevision(d, 'feet')
      const rev = await addRevision(d, 'hat')
      // hat revision 2, paid as the second revision line in its checkout
      const { entitlement } = await entitle(d, rev, { amountCents: 1000, paidAt: opts.paidAt, paymentIntent: 'pi_rev' })
      return { d, entitlement }
    }

    it("a report refunds the revision's line in full", async () => {
      const u = await createUser()
      const { d, entitlement } = await revised(u)
      const res = await report(u, d.id, 'hat', 2)
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ status: 'refunded', refundCents: 1000 })
      expect(stripe.calls.refunds).toEqual([{
        params: expect.objectContaining({ payment_intent: 'pi_rev', amount: 1000 }),
        opts: { idempotencyKey: `studio-report-${entitlement.id}` },
      }])
      const [row] = await db.select().from(studioMistakeReports)
      expect(row).toMatchObject({ entitlementId: entitlement.id, status: 'refunded', refundCents: 1000, text: 'the sleeve clips through the arm when waving' })
      expect(row.stripeRefundId).toMatch(/^re_/)
      const [pay] = await db.select().from(studioPayments).where(eq(studioPayments.id, entitlement.paymentId))
      expect(pay.refundedCents).toBe(1000)
    })

    it('a second report is 409 already_reported', async () => {
      const u = await createUser()
      const { d } = await revised(u)
      await report(u, d.id, 'hat', 2)
      const again = await report(u, d.id, 'hat', 2)
      expect(again.statusCode).toBe(409)
      expect(again.json().code).toBe('already_reported')
      expect(stripe.calls.refunds).toHaveLength(1)
    })

    it("a first finalize can't be reported", async () => {
      const u = await createUser()
      const { d } = await revised(u)
      const res = await report(u, d.id, 'hat', 1)
      expect(res.statusCode).toBe(409)
      expect(res.json().code).toBe('not_a_revision')
    })

    it('after 30 days the window is closed', async () => {
      const u = await createUser()
      const { d } = await revised(u, { paidAt: new Date(Date.now() - 31 * 24 * 3600 * 1000) })
      const res = await report(u, d.id, 'hat', 2)
      expect(res.statusCode).toBe(409)
      expect(res.json().code).toBe('report_window_closed')
    })

    it('a refused refund stores no report', async () => {
      const u = await createUser()
      const { d, entitlement } = await revised(u)
      stripe.failRefunds = true
      const res = await report(u, d.id, 'hat', 2)
      expect(res.statusCode).toBe(502)
      expect(res.json().code).toBe('stripe_error')
      expect(await db.select().from(studioMistakeReports)).toHaveLength(0)
      stripe.failRefunds = false
      expect((await report(u, d.id, 'hat', 2)).statusCode).toBe(200)
      expect(stripe.calls.refunds.map((r) => r.opts.idempotencyKey)).toEqual([`studio-report-${entitlement.id}`, `studio-report-${entitlement.id}`])
    })

    it('the customer keeps the files after a refund', async () => {
      const u = await createUser()
      const { d, entitlement } = await revised(u)
      expect((await report(u, d.id, 'hat', 2)).statusCode).toBe(200)
      const [e] = await db.select().from(studioEntitlements).where(eq(studioEntitlements.id, entitlement.id))
      expect(e.status).toBe('ready')
    })

    it('report input and ownership are checked', async () => {
      const u = await createUser()
      const { d } = await revised(u)
      expect((await report(u, d.id, 'hat', 2, 'short')).statusCode).toBe(400)
      expect((await report(u, d.id, 'hat', 9)).statusCode).toBe(402)
      expect((await report(u, d.id, 'hat', 9)).json().code).toBe('not_paid')
      expect((await report(await createUser(), d.id, 'hat', 2)).statusCode).toBe(404)
    })

    it('nothing charged means nothing to refund', async () => {
      const u = await createUser()
      const d = await createDesign(u)
      await entitle(d, await addRevision(d, 'hat'))
      await entitle(d, await addRevision(d, 'hat'), { amountCents: 0 })
      const res = await report(u, d.id, 'hat', 2)
      expect(res.statusCode).toBe(409)
      expect(res.json().code).toBe('nothing_charged')
    })
  })
})
