import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { studioDesigns, studioJobs, studioRenders } from '../db/schema.js'
import { config } from '../config.js'
import { authenticate } from '../middleware/auth.js'
import { getSubscription } from '../integrations/stripe.js'
import { getStudioStore, jobFileKey } from '../studio/store.js'
import { verifyRenderFrame, framePath } from '../studio/render-urls.js'
import { quoteFinalize, QuoteError } from '../studio/pricing.js'
import { createFinalizeCheckout, createTopupCheckout, reportMistake, PaymentError } from '../studio/payments.js'
import {
  BASE_EMOTES, BODY_SHAPES, OUTFITS, WEARABLE_CATEGORIES,
  designDetail, openDesignCount, publicDesign, queuePrompt, requestRender, usage, type Design, type View,
} from '../studio/designs.js'

/**
 * The dashboard's Design Studio API. A design belongs to its owner alone: anyone else gets 404. Files never leave
 * through here, only signed render-frame URLs (render-urls.ts).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_PROMPT = 4000
const MAX_NAME = 120
const AGENTS = ['claude', 'codex']
const REPORT_MIN = 10
const REPORT_MAX = 2000
const MAX_PACKS = 10

async function studioOn(_request: FastifyRequest, reply: FastifyReply) {
  if (!config.studioEnabled) return reply.status(404).send({ error: 'not_found' })
}

const paymentsOff = (reply: FastifyReply) => reply.status(503).send({ error: 'Payments are not available', code: 'payments_unavailable' })

/** Checkout failures as the page sees them. */
function checkoutRefusal(reply: FastifyReply, err: unknown) {
  if (err instanceof QuoteError) return quoteRefusal(reply, err)
  if (err instanceof PaymentError) return reply.status(err.status).send({ error: err.code, code: err.code })
  throw err
}

const notFound = (reply: FastifyReply) => reply.status(404).send({ error: 'design_not_found' })

async function ownDesign(request: FastifyRequest): Promise<Design | null> {
  const id = (request.params as { id: string }).id
  if (!UUID.test(id)) return null
  const [d] = await db.select().from(studioDesigns).where(and(eq(studioDesigns.id, id), eq(studioDesigns.ownerId, request.user.id)))
  return d ?? null
}

/** Agent check shared by create and update: grok is announced but not offered yet. */
function agentError(agent: unknown): string | null {
  if (agent === 'grok') return 'Grok is coming soon'
  if (!AGENTS.includes(agent as string)) return 'agent must be claude or codex'
  return null
}

/** A quote refusal as the page sees it: an unknown piece is the caller's mistake, the rest are the design's state. */
export function quoteRefusal(reply: FastifyReply, err: QuoteError) {
  return reply.status(err.code === 'unknown_piece' ? 400 : 409).send({ error: err.code, code: err.code, categories: err.categories })
}

async function openLimit(userId: string) {
  return (await getSubscription(userId)).limits.studioOpenDesigns
}

export default async function studioRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticate, studioOn] }

  app.get('/api/studio/usage', auth, async (request) => {
    return usage(request.user.id, await openLimit(request.user.id), new Date())
  })

  app.post('/api/studio/designs', auth, async (request, reply) => {
    const b = (request.body ?? {}) as { kind?: unknown; agent?: unknown; name?: unknown }
    const err = agentError(b.agent)
    if (err) return reply.status(400).send({ error: err })
    if (b.kind !== 'wearable' && b.kind !== 'emote') return reply.status(400).send({ error: 'kind must be wearable or emote' })
    if (b.name !== undefined && (typeof b.name !== 'string' || !b.name.trim() || b.name.length > MAX_NAME)) {
      return reply.status(400).send({ error: `name must be 1-${MAX_NAME} characters` })
    }
    if ((await openDesignCount(request.user.id)) >= (await openLimit(request.user.id))) {
      return reply.status(403).send({ error: 'Your plan has no room for another open design', code: 'open_design_limit' })
    }
    const [d] = await db.insert(studioDesigns).values({
      ownerId: request.user.id,
      name: typeof b.name === 'string' ? b.name.trim() : b.kind === 'emote' ? 'Untitled emote' : 'Untitled design',
      kind: b.kind,
      agent: b.agent as string,
    }).returning()
    return reply.status(201).send(publicDesign(d))
  })

  app.get('/api/studio/designs', auth, async (request) => {
    const archived = (request.query as { archived?: string }).archived === 'true'
    const rows = await db.select().from(studioDesigns)
      .where(and(eq(studioDesigns.ownerId, request.user.id), archived ? isNotNull(studioDesigns.archivedAt) : isNull(studioDesigns.archivedAt)))
      .orderBy(desc(studioDesigns.createdAt))
    return rows.map(publicDesign)
  })

  app.get('/api/studio/designs/:id', auth, async (request, reply) => {
    const d = await ownDesign(request)
    if (!d) return notFound(reply)
    return designDetail(d, new Date())
  })

  app.patch('/api/studio/designs/:id', auth, async (request, reply) => {
    const d = await ownDesign(request)
    if (!d) return notFound(reply)
    const b = (request.body ?? {}) as { name?: unknown; agent?: unknown; archived?: unknown }
    const set: Partial<typeof studioDesigns.$inferInsert> = {}
    if (b.name !== undefined) {
      if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > MAX_NAME) return reply.status(400).send({ error: `name must be 1-${MAX_NAME} characters` })
      set.name = b.name.trim()
    }
    if (b.agent !== undefined) {
      const err = agentError(b.agent)
      if (err) return reply.status(400).send({ error: err })
      set.agent = b.agent as string
    }
    if (b.archived !== undefined) {
      if (typeof b.archived !== 'boolean') return reply.status(400).send({ error: 'archived must be true or false' })
      if (!b.archived && d.archivedAt && (await openDesignCount(request.user.id)) >= (await openLimit(request.user.id))) {
        return reply.status(403).send({ error: 'Your plan has no room for another open design', code: 'open_design_limit' })
      }
      set.archivedAt = b.archived ? (d.archivedAt ?? new Date()) : null
    }
    const [updated] = Object.keys(set).length
      ? await db.update(studioDesigns).set(set).where(eq(studioDesigns.id, d.id)).returning()
      : [d]
    return publicDesign(updated)
  })

  app.post('/api/studio/designs/:id/prompts', auth, async (request, reply) => {
    const d = await ownDesign(request)
    if (!d) return notFound(reply)
    const b = (request.body ?? {}) as { text?: unknown; selectedSlots?: unknown; continue?: unknown; fixChecks?: unknown }
    const cont = b.continue === true
    const fixChecks = b.fixChecks === true
    if (fixChecks) {
      const r = await queuePrompt(d, { text: null, selectedSlots: null, continue: false, fixChecks: true }, new Date())
      if (!r.ok) return reply.status(r.status).send(r.body)
      return reply.status(202).send({ jobId: r.jobId })
    }
    if (!cont && (typeof b.text !== 'string' || !b.text.trim() || b.text.length > MAX_PROMPT)) {
      return reply.status(400).send({ error: `text must be 1-${MAX_PROMPT} characters` })
    }
    let slots: string[] | null = null
    if (b.selectedSlots != null) {
      if (d.kind !== 'wearable') return reply.status(400).send({ error: 'only a wearable design has slots' })
      if (!Array.isArray(b.selectedSlots) || !b.selectedSlots.length
        || !b.selectedSlots.every((s) => (WEARABLE_CATEGORIES as readonly string[]).includes(s))) {
        return reply.status(400).send({ error: 'selectedSlots must be wearable categories' })
      }
      slots = [...new Set(b.selectedSlots as string[])]
    }
    const r = await queuePrompt(d, { text: cont ? null : (b.text as string).trim(), selectedSlots: slots, continue: cont }, new Date())
    if (!r.ok) return reply.status(r.status).send(r.body)
    return reply.status(202).send({ jobId: r.jobId })
  })

  app.get('/api/studio/designs/:id/finalize', auth, async (request, reply) => {
    const d = await ownDesign(request)
    if (!d) return notFound(reply)
    try {
      return await quoteFinalize(d, null, [])
    } catch (err) {
      if (err instanceof QuoteError) return quoteRefusal(reply, err)
      throw err
    }
  })

  app.post('/api/studio/designs/:id/finalize', auth, async (request, reply) => {
    const d = await ownDesign(request)
    if (!d) return notFound(reply)
    if (!config.stripeSecretKey) return paymentsOff(reply)
    const b = (request.body ?? {}) as { categories?: unknown; reports?: unknown }
    let categories: string[] | null = null
    if (b.categories != null) {
      if (!Array.isArray(b.categories) || !b.categories.length || !b.categories.every((c) => typeof c === 'string' && /^[a-z_]{1,32}$/.test(c))) {
        return reply.status(400).send({ error: 'categories must be piece categories' })
      }
      categories = [...new Set(b.categories as string[])]
    }
    const reports: Record<string, string> = {}
    if (b.reports != null) {
      if (typeof b.reports !== 'object' || Array.isArray(b.reports)) return reply.status(400).send({ error: 'reports must map a category to what was wrong' })
      for (const [category, text] of Object.entries(b.reports as Record<string, unknown>)) {
        if (!/^[a-z_]{1,32}$/.test(category) || typeof text !== 'string' || text.trim().length < REPORT_MIN || text.length > REPORT_MAX) {
          return reply.status(400).send({ error: `a report must be ${REPORT_MIN}-${REPORT_MAX} characters` })
        }
        reports[category] = text.trim()
      }
    }
    try {
      return await createFinalizeCheckout(d, { id: request.user.id, email: request.user.email ?? null }, categories, reports, new Date())
    } catch (err) {
      return checkoutRefusal(reply, err)
    }
  })

  app.post('/api/studio/designs/:id/pieces/:category/revisions/:number/report', auth, async (request, reply) => {
    const d = await ownDesign(request)
    if (!d) return notFound(reply)
    if (!config.stripeSecretKey) return paymentsOff(reply)
    const { category, number } = request.params as { category: string; number: string }
    if (!/^[a-z_]{1,32}$/.test(category) || !/^[1-9][0-9]{0,5}$/.test(number)) return reply.status(400).send({ error: 'unknown revision' })
    const text = (request.body as { text?: unknown } | null)?.text
    if (typeof text !== 'string' || text.trim().length < REPORT_MIN || text.length > REPORT_MAX) {
      return reply.status(400).send({ error: `a report must be ${REPORT_MIN}-${REPORT_MAX} characters` })
    }
    try {
      return await reportMistake(d, category, Number(number), text.trim(), new Date())
    } catch (err) {
      return checkoutRefusal(reply, err)
    }
  })

  app.post('/api/studio/topups', auth, async (request, reply) => {
    if (!config.stripeSecretKey) return paymentsOff(reply)
    const packs = (request.body as { packs?: unknown } | null)?.packs ?? 1
    if (!Number.isInteger(packs) || (packs as number) < 1 || (packs as number) > MAX_PACKS) {
      return reply.status(400).send({ error: `packs must be 1-${MAX_PACKS}` })
    }
    try {
      return await createTopupCheckout({ id: request.user.id, email: request.user.email ?? null }, packs as number, new Date())
    } catch (err) {
      return checkoutRefusal(reply, err)
    }
  })

  app.post('/api/studio/designs/:id/renders', auth, async (request, reply) => {
    const d = await ownDesign(request)
    if (!d) return notFound(reply)
    const b = (request.body ?? {}) as { category?: unknown; bodyShape?: unknown; outfit?: unknown; emote?: unknown }
    const categoryOk = d.kind === 'emote' ? b.category === 'emote' : (WEARABLE_CATEGORIES as readonly string[]).includes(b.category as string)
    if (!categoryOk) return reply.status(400).send({ error: 'unknown category' })
    if (!(BODY_SHAPES as readonly unknown[]).includes(b.bodyShape)) return reply.status(400).send({ error: 'bodyShape must be male or female' })
    if (!(OUTFITS as readonly unknown[]).includes(b.outfit)) return reply.status(400).send({ error: 'unknown outfit' })
    const emote = b.emote ?? null
    if (emote !== null && (d.kind === 'emote' || !(BASE_EMOTES as readonly unknown[]).includes(emote))) {
      return reply.status(400).send({ error: 'unknown emote' })
    }
    const view = { bodyShape: b.bodyShape, outfit: b.outfit, emote } as View
    const r = await requestRender(d, b.category as string, view, new Date())
    if (!r) return reply.status(404).send({ error: 'piece_not_found' })
    return r
  })

  // The signed token is the authority: no bearer. Every check failing is the same 403. A wildcard, not :token, because
  // tokens pass Fastify's 100-character parameter limit.
  // One view is 36 frames: a page loads hundreds a minute, so frames get their own, higher limit
  app.get('/api/studio/render-frames/*', { preHandler: studioOn, schema: { hide: true }, config: { rateLimit: { max: 3000, timeWindow: '1 minute' } } }, async (request, reply) => {
    const f = verifyRenderFrame((request.params as { '*': string })['*'], new Date())
    const forbidden = () => reply.status(403).send({ error: 'forbidden' })
    if (!f || !UUID.test(f.jobId) || !UUID.test(f.designId) || !UUID.test(f.revisionId)) return forbidden()
    if (!/^[a-z_]+$/.test(f.category) || !/^[a-z0-9-]+$/.test(f.viewKey)) return forbidden()
    const [job] = await db.select({ designId: studioJobs.designId }).from(studioJobs).where(eq(studioJobs.id, f.jobId))
    if (!job || job.designId !== f.designId) return forbidden()
    const [render] = await db.select({ frames: studioRenders.frames }).from(studioRenders)
      .where(and(eq(studioRenders.revisionId, f.revisionId), eq(studioRenders.viewKey, f.viewKey), eq(studioRenders.jobId, f.jobId), eq(studioRenders.status, 'ready')))
    if (!render || f.frame >= render.frames) return forbidden()
    const obj = await getStudioStore().get(jobFileKey(f.designId, f.jobId, framePath(f)))
    if (!obj) return reply.status(404).send({ error: 'frame_not_found' })
    return reply.type('image/webp').header('Cache-Control', 'private, max-age=3600').send(obj.body)
  })
}
