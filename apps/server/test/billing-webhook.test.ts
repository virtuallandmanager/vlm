import { describe, it, expect } from 'vitest'
import Stripe from 'stripe'
import { verifyWebhookEvent } from '../src/billing/webhook-verify.js'
import { testApp } from './helpers/factories.js'

const secret = 'whsec_test_secret'
const stripeKey = 'sk_test_dummy'
const payload = JSON.stringify({
  id: 'evt_1',
  object: 'event',
  type: 'customer.subscription.updated',
  data: { object: {} },
})
const stripe = new Stripe(stripeKey)
const sign = (p: string) => stripe.webhooks.generateTestHeaderString({ payload: p, secret })
const base = { secret, stripeKey, mode: 'single' as const, nodeEnv: 'test' }

describe('verifyWebhookEvent', () => {
  it('rejects a missing signature when a secret is set', async () => {
    expect(await verifyWebhookEvent(payload, undefined, base)).toEqual({
      ok: false, status: 400, error: 'Missing Stripe signature',
    })
  })

  it('accepts a correctly signed event', async () => {
    const res = await verifyWebhookEvent(payload, sign(payload), base)
    expect(res.ok).toBe(true)
    if (res.ok) expect((res.event as any).type).toBe('customer.subscription.updated')
  })

  it('rejects a signature over a different payload', async () => {
    const res = await verifyWebhookEvent(payload, sign(payload + ' '), base)
    expect(res).toEqual({ ok: false, status: 400, error: 'Webhook signature verification failed' })
  })

  it('rejects a bad signature header', async () => {
    const res = await verifyWebhookEvent(payload, 't=1,v1=abc', base)
    expect(res).toMatchObject({ ok: false, status: 400 })
  })

  it('never falls back when the raw body is missing', async () => {
    const res = await verifyWebhookEvent(undefined, sign(payload), base)
    expect(res).toEqual({ ok: false, status: 400, error: 'Webhook signature verification failed' })
  })

  it('refuses with 503 when no secret is set in cloud mode', async () => {
    const res = await verifyWebhookEvent(payload, undefined, { ...base, secret: undefined, mode: 'cloud' })
    expect(res).toEqual({ ok: false, status: 503, error: 'Webhook secret not configured' })
  })

  it('refuses with 503 when no secret is set in production', async () => {
    const res = await verifyWebhookEvent(payload, undefined, { ...base, secret: undefined, nodeEnv: 'production' })
    expect(res).toMatchObject({ ok: false, status: 503 })
  })

  it('accepts the parsed raw body in local dev with no secret', async () => {
    const res = await verifyWebhookEvent(payload, undefined, { ...base, secret: undefined })
    expect(res.ok).toBe(true)
    if (res.ok) expect((res.event as any).id).toBe('evt_1')
  })
})

describe('POST /api/billing/webhook', () => {
  it('does not process an unsigned event', async () => {
    const app = await testApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/billing/webhook',
      headers: { 'content-type': 'application/json' },
      payload,
    })
    // 404 when billing is disabled in tests; otherwise 400/503. Never 200.
    expect([400, 404, 503]).toContain(res.statusCode)
    await app.close()
  })
})
