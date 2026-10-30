import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import Stripe from 'stripe'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { studioEntitlements, studioFlags, studioPauses, studioPayments, studioScopeEvents } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { setStripe } from '../src/integrations/stripe.js'
import { memoryStudioStore, setStudioStore } from '../src/studio/store.js'
import { setMachineDeps } from '../src/studio/machines.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor, type TestUser } from './helpers/factories.js'
import { addRevision, createDesign, entitle, fakeFly, fakeStripe } from './helpers/studio.js'

const WEBHOOK_SECRET = 'whsec_studio_admin_test'
const signer = new Stripe('sk_test_dummy')

describe('studio admin: flags and pauses', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let stripe: ReturnType<typeof fakeStripe>
  let admin: TestUser
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
    setMachineDeps({ fly: fakeFly() })
    setStudioStore(memoryStudioStore())
    app = await testApp()
    admin = await createUser({ role: 'admin' })
  })

  const as = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })
  const pause = (userId: string, by = admin) => app.inject({ method: 'POST', url: `/api/admin/studio/users/${userId}/pause`, headers: as(by) })
  const resume = (userId: string) => app.inject({ method: 'DELETE', url: `/api/admin/studio/users/${userId}/pause`, headers: as(admin) })
  const paid = async (paymentId: string) => {
    const payload = JSON.stringify({ id: `evt_${Math.random()}`, object: 'event', type: 'checkout.session.completed', data: { object: {
      id: 'cs_x', object: 'checkout.session', mode: 'payment', payment_status: 'paid', payment_intent: 'pi_paused',
      metadata: { vlm_studio_payment_id: paymentId, vlm_user_id: 'x' },
    } } })
    const res = await app.inject({
      method: 'POST', url: '/api/billing/webhook',
      headers: { 'content-type': 'application/json', 'stripe-signature': signer.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET }) },
      payload,
    })
    expect(res.statusCode).toBe(200)
  }

  it('a paused account is refused new work', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    await addRevision(d, 'hat')
    expect((await pause(u.id)).statusCode).toBe(204)
    const refused = [
      await app.inject({ method: 'POST', url: '/api/studio/designs', headers: as(u), payload: { kind: 'wearable', agent: 'claude' } }),
      await app.inject({ method: 'POST', url: `/api/studio/designs/${d.id}/prompts`, headers: as(u), payload: { text: 'a cap' } }),
      await app.inject({ method: 'POST', url: `/api/studio/designs/${d.id}/prompts`, headers: as(u), payload: { fixChecks: true } }),
      await app.inject({ method: 'POST', url: `/api/studio/designs/${d.id}/renders`, headers: as(u), payload: { categories: ['hat'], bodyShape: 'female', outfit: 'default', emote: null } }),
      await app.inject({ method: 'POST', url: `/api/studio/designs/${d.id}/uploads?name=logo.png`, headers: { ...as(u), 'content-type': 'image/png' }, payload: Buffer.from('x') }),
      await app.inject({ method: 'POST', url: '/api/studio/topups', headers: as(u), payload: { packs: 1 } }),
    ]
    for (const res of refused) expect([res.statusCode, res.json().code]).toEqual([403, 'studio_paused'])
  })

  it('a paused account can still read, finalize, pay and report', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    await entitle(d, await addRevision(d, 'hat'))
    await addRevision(d, 'feet')
    const rev = await addRevision(d, 'hat')
    await entitle(d, rev, { amountCents: 1500, paymentIntent: 'pi_rev' })
    await pause(u.id)
    expect((await app.inject({ method: 'GET', url: `/api/studio/designs/${d.id}`, headers: as(u) })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: `/api/studio/designs/${d.id}/finalize`, headers: as(u) })).statusCode).toBe(200)
    const checkout = await app.inject({ method: 'POST', url: `/api/studio/designs/${d.id}/finalize`, headers: as(u), payload: { categories: ['feet'] } })
    expect(checkout.statusCode).toBe(200)
    expect(checkout.json().url).toMatch(/^https:\/\/checkout\.stripe\.test\//)
    const report = await app.inject({ method: 'POST', url: `/api/studio/designs/${d.id}/pieces/hat/revisions/2/report`, headers: as(u), payload: { text: 'the sleeve clips through the arm when waving' } })
    expect(report.statusCode).toBe(200)
    const pkg = await app.inject({ method: 'GET', url: `/api/studio/designs/${d.id}/pieces/hat/revisions/1/package`, headers: as(u) })
    expect(pkg.statusCode).not.toBe(403)
  })

  it('a checkout opened before the pause still grants on the webhook', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    await addRevision(d, 'hat')
    expect((await app.inject({ method: 'POST', url: `/api/studio/designs/${d.id}/finalize`, headers: as(u), payload: {} })).statusCode).toBe(200)
    const [payment] = await db.select().from(studioPayments).where(eq(studioPayments.designId, d.id))
    await pause(u.id)
    await paid(payment.id)
    expect(await db.select().from(studioEntitlements).where(eq(studioEntitlements.paymentId, payment.id))).toHaveLength(1)
  })

  it('usage says paused', async () => {
    const u = await createUser()
    const usage = () => app.inject({ method: 'GET', url: '/api/studio/usage', headers: as(u) })
    expect((await usage()).json().paused).toBe(false)
    await pause(u.id)
    expect((await usage()).json().paused).toBe(true)
    expect((await resume(u.id)).statusCode).toBe(204)
    expect((await usage()).json().paused).toBe(false)
  })

  it('admins list, dismiss, pause and resume; others are refused', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    await db.insert(studioScopeEvents).values({ userId: u.id, designId: d.id, by: 'check', category: 'coding', note: 'python', message: 'write python' })
    const [flag] = await db.insert(studioFlags).values({ userId: u.id }).returning()
    const list = async (status = 'open') => (await app.inject({ method: 'GET', url: `/api/admin/studio/flags?status=${status}`, headers: as(admin) })).json().flags
    const open = await list()
    expect(open).toHaveLength(1)
    expect(open[0]).toMatchObject({ id: flag.id, status: 'open', paused: false, user: { id: u.id, email: u.email, plan: 'free' } })
    expect(open[0].events).toEqual([expect.objectContaining({ by: 'check', category: 'coding', note: 'python', message: 'write python', designId: d.id })])
    await pause(u.id)
    expect((await list())[0].paused).toBe(true)
    expect((await db.select().from(studioPauses))[0]).toMatchObject({ userId: u.id, pausedBy: admin.id })
    expect((await app.inject({ method: 'POST', url: `/api/admin/studio/flags/${flag.id}/dismiss`, headers: as(admin) })).statusCode).toBe(204)
    expect(await list()).toHaveLength(0)
    expect(await list('closed')).toEqual([expect.objectContaining({ id: flag.id, status: 'dismissed' })])
    const creator = await createUser()
    for (const res of [
      await app.inject({ method: 'GET', url: '/api/admin/studio/flags', headers: as(creator) }),
      await pause(u.id, creator),
      await app.inject({ method: 'POST', url: `/api/admin/studio/flags/${flag.id}/dismiss`, headers: as(creator) }),
    ]) expect(res.statusCode).toBe(403)
  })
})
