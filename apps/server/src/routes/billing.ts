/**
 * Billing Routes — Stripe subscription management.
 *
 * POST /api/billing/checkout     — Create Stripe Checkout session for upgrade
 * POST /api/billing/portal       — Create Stripe Customer Portal session
 * GET  /api/billing/subscription — Get current subscription + tier limits
 * GET  /api/billing/usage        — Get current usage vs limits
 * POST /api/billing/webhook      — Stripe webhook (not JWT-authenticated)
 */

import { FastifyInstance } from 'fastify'
import { eq, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { mediaAssets, scenes, streamingSessions } from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'
import { config } from '../config.js'
import {
  createCheckoutSession,
  createPortalSession,
  handleWebhookEvent,
  getSubscription,
} from '../integrations/stripe.js'

export default async function billingRoutes(app: FastifyInstance) {
  // ── Create Checkout Session ───────────────────────────────────────────
  app.post(
    '/api/billing/checkout',
    { preHandler: [authenticate] },
    async (request, reply) => {
      if (!config.billingEnabled) {
        return reply.status(403).send({ error: 'Billing is not enabled on this instance' })
      }

      const body = request.body as {
        priceId: string
        successUrl?: string
        cancelUrl?: string
      }

      if (!body.priceId) {
        return reply.status(400).send({ error: 'Missing required field: priceId' })
      }

      const baseUrl = config.publicUrl
      const result = await createCheckoutSession({
        userId: request.user.id,
        email: request.user.email || '',
        priceId: body.priceId,
        successUrl: body.successUrl || `${baseUrl}/billing?success=true`,
        cancelUrl: body.cancelUrl || `${baseUrl}/billing?canceled=true`,
      })

      return reply.send(result)
    },
  )

  // ── Create Portal Session ─────────────────────────────────────────────
  app.post(
    '/api/billing/portal',
    { preHandler: [authenticate] },
    async (request, reply) => {
      if (!config.billingEnabled) {
        return reply.status(403).send({ error: 'Billing is not enabled on this instance' })
      }

      const body = request.body as { returnUrl?: string }

      const result = await createPortalSession({
        userId: request.user.id,
        returnUrl: body.returnUrl || `${config.publicUrl}/billing`,
      })

      return reply.send(result)
    },
  )

  // ── Get Subscription ──────────────────────────────────────────────────
  app.get(
    '/api/billing/subscription',
    { preHandler: [authenticate] },
    async (request, reply) => {
      if (!config.billingEnabled) {
        return reply.send({
          tier: 'studio', // self-hosted gets everything
          status: 'active',
          billingEnabled: false,
          limits: null,
        })
      }

      const sub = await getSubscription(request.user.id)
      return reply.send(sub)
    },
  )

  // ── Get Usage ─────────────────────────────────────────────────────────
  app.get(
    '/api/billing/usage',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const sub = await getSubscription(request.user.id)

      // Count scenes
      const [sceneCount] = await db
        .select({ count: sql<number>`count(*)` })
        .from(scenes)
        .where(eq(scenes.ownerId, request.user.id))

      // Sum storage bytes
      const [storageSum] = await db
        .select({ total: sql<number>`coalesce(sum(${mediaAssets.sizeBytes}), 0)` })
        .from(mediaAssets)
        .where(eq(mediaAssets.ownerId, request.user.id))

      // Sum streaming minutes this billing period
      let streamMinutes = 0
      if (sub.tier !== 'free') {
        const periodStart = (sub as any).currentPeriodStart || new Date(0)
        const [streamSum] = await db
          .select({
            total: sql<number>`coalesce(sum(${streamingSessions.durationSeconds}), 0)`,
          })
          .from(streamingSessions)
          // Sessions are linked via servers owned by the user — simplified here
          .where(sql`${streamingSessions.startedAt} >= ${periodStart}`)

        streamMinutes = Math.ceil(Number(streamSum.total) / 60)
      }

      return reply.send({
        tier: sub.tier,
        usage: {
          scenes: Number(sceneCount.count),
          storageBytes: Number(storageSum.total),
          streamMinutes,
        },
        limits: sub.limits,
      })
    },
  )

  // ── Stripe Webhook ────────────────────────────────────────────────────
  // NOT authenticated via JWT — uses Stripe signature verification
  app.post('/api/billing/webhook', {
    config: {
      rawBody: true, // Need raw body for Stripe signature verification
    },
    handler: async (request, reply) => {
      if (!config.billingEnabled || !config.stripeSecretKey) {
        return reply.status(404).send({ error: 'Billing not enabled' })
      }

      const sig = (request.headers as any)['stripe-signature']
      const webhookSecret = config.stripeWebhookSecret

      let event: any

      if (webhookSecret && sig) {
        try {
          const { default: Stripe } = await import('stripe')
          const stripe = new Stripe(config.stripeSecretKey!)
          event = stripe.webhooks.constructEvent(
            (request as any).rawBody || request.body,
            sig,
            webhookSecret,
          )
        } catch (err) {
          return reply.status(400).send({
            error: 'Webhook signature verification failed',
          })
        }
      } else {
        // No webhook secret configured — accept raw body (dev mode)
        event = request.body
      }

      try {
        await handleWebhookEvent(event)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return reply.status(500).send({ error: `Webhook processing failed: ${message}` })
      }

      return reply.send({ received: true })
    },
  })
}
