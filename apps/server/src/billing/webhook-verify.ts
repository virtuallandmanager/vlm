import type { VirviMode } from '../config.js'

export type WebhookVerification =
  | { ok: true; event: unknown }
  | { ok: false; status: number; error: string }

const SIGNATURE_FAILED = { ok: false, status: 400, error: 'Webhook signature verification failed' } as const

/**
 * Verify a Stripe webhook against the exact raw request body.
 * Unsigned events are only accepted in local dev (no secret, not cloud, not production).
 */
export async function verifyWebhookEvent(
  rawBody: string | undefined,
  sig: string | undefined,
  opts: { secret: string | undefined; stripeKey: string; mode: VirviMode; nodeEnv: string | undefined },
): Promise<WebhookVerification> {
  if (opts.secret) {
    if (!sig) return { ok: false, status: 400, error: 'Missing Stripe signature' }
    if (rawBody === undefined) return SIGNATURE_FAILED
    try {
      const { default: Stripe } = await import('stripe')
      const stripe = new Stripe(opts.stripeKey)
      return { ok: true, event: stripe.webhooks.constructEvent(rawBody, sig, opts.secret) }
    } catch {
      return SIGNATURE_FAILED
    }
  }

  if (opts.mode === 'cloud' || opts.nodeEnv === 'production') {
    return { ok: false, status: 503, error: 'Webhook secret not configured' }
  }

  try {
    return { ok: true, event: JSON.parse(rawBody ?? '') }
  } catch {
    return { ok: false, status: 400, error: 'Invalid webhook body' }
  }
}
