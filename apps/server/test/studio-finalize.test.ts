import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { studioDesigns, studioEntitlements, studioJobs, studioMessages, studioPayments, studioUsageDays } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { setStripe } from '../src/integrations/stripe.js'
import { memoryStudioStore, setStudioStore, jobFileKey } from '../src/studio/store.js'
import { setMachineDeps } from '../src/studio/machines.js'
import { quoteFinalize } from '../src/studio/pricing.js'
import { grantPayment } from '../src/studio/payments.js'
import { failJobs } from '../src/studio/results.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor, type TestUser } from './helpers/factories.js'
import { createDesign, addRevision, fakeFly, fakeStripe, issueWorker } from './helpers/studio.js'

const PACKAGE = 'final/hat/package.zip'
const CHECKS = { thumbnail: { pass: true }, listing: { pass: true }, clipping: { pass: false, failed: ['Dance'] }, emoteCheck: null }

describe('studio finalize jobs and downloads', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let store: ReturnType<typeof memoryStudioStore>
  let stripe: ReturnType<typeof fakeStripe>
  const prev = { enabled: config.studioEnabled, key: config.stripeSecretKey, image: config.studioWorkerImage }
  beforeAll(() => {
    ;(config as any).studioEnabled = true
    ;(config as any).studioWorkerImage = 'registry.fly.io/vlm-studio-worker:test'
    ;(config as any).stripeSecretKey = 'sk_test_studio'
  })
  afterAll(() => {
    ;(config as any).studioEnabled = prev.enabled
    ;(config as any).studioWorkerImage = prev.image
    ;(config as any).stripeSecretKey = prev.key
    setStripe(null)
    setMachineDeps(null)
    setStudioStore(null)
  })
  beforeEach(async () => {
    await resetDb()
    store = memoryStudioStore()
    setStudioStore(store)
    stripe = fakeStripe()
    setStripe(stripe)
    setMachineDeps({ fly: fakeFly() })
    app = await testApp()
  })

  const as = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` })

  /** A design with a built hat whose files are stored, paid for and granted: its finalize job is queued. */
  async function paidHat(u: TestUser) {
    const d = await createDesign(u, { name: 'Neon set' })
    const rev = await addRevision(d, 'hat')
    for (const f of rev.files) await store.put(jobFileKey(d.id, rev.jobId, f), Buffer.from(`v1:${f}`), f.endsWith('.glb') ? 'model/gltf-binary' : 'text/plain')
    const q = await quoteFinalize(d, ['hat'], [])
    const [pay] = await db.insert(studioPayments).values({ userId: u.id, designId: d.id, kind: 'finalize', amountCents: q.totalCents, lines: q.lines }).returning()
    expect(await grantPayment(pay.id, 'pi_test', new Date())).toBe('granted')
    const token = await issueWorker(d)
    return { d, rev, token, pay }
  }
  async function take(token: string, designId: string) {
    const res = await app.inject({ method: 'GET', url: `/api/studio/worker/designs/${designId}/jobs/next`, headers: bearer(token) })
    expect(res.statusCode).toBe(200)
    return res.json()
  }
  const upload = (token: string, jobId: string, path: string, body: Buffer, type = 'application/zip') =>
    app.inject({ method: 'PUT', url: `/api/studio/worker/jobs/${jobId}/files/${path}`, headers: { ...bearer(token), 'content-type': type }, payload: body })
  const result = (token: string, jobId: string, body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/api/studio/worker/jobs/${jobId}/result`, headers: bearer(token), payload: body as any })
  const download = (u: TestUser, designId: string, n = 1) =>
    app.inject({ method: 'GET', url: `/api/studio/designs/${designId}/pieces/hat/revisions/${n}/package`, headers: as(u) })
  const entitlementOf = async (designId: string) => (await db.select().from(studioEntitlements).where(eq(studioEntitlements.designId, designId)))[0]

  it("the finalize job names the paid revision's files", async () => {
    const u = await createUser()
    const { d, rev, token } = await paidHat(u)
    const job = await take(token, d.id)
    expect(job).toMatchObject({
      type: 'finalize', kind: 'wearable', agent: null, model: null, prompt: null,
      limits: { timeoutSec: 1800, maxTurns: 0, costCeilingUsd: 0 },
      finalize: { designName: 'Neon set', pieces: [{ category: 'hat', revision: 1, files: rev.files, sourceJobId: rev.jobId }] },
    })
  })

  it("finalize inputs are the paid revision's files only", async () => {
    const u = await createUser()
    const { d, rev, token } = await paidHat(u)
    const job = await take(token, d.id)
    // a later prompt makes revision 2; the package is still built from revision 1's stored files
    const rev2 = await addRevision(d, 'hat')
    await store.put(jobFileKey(d.id, rev2.jobId, rev.files[0]), Buffer.from('v2'), 'model/gltf-binary')
    const input = (path: string, t = token, jobId = job.jobId) =>
      app.inject({ method: 'GET', url: `/api/studio/worker/jobs/${jobId}/inputs/${path}`, headers: bearer(t) })
    const glb = await input(rev.files[0])
    expect(glb.statusCode).toBe(200)
    expect(glb.rawPayload.toString()).toBe(`v1:${rev.files[0]}`)
    expect(glb.headers['content-type']).toBe('model/gltf-binary')
    expect((await input('pieces/hat/other.glb')).statusCode).toBe(404)
    expect((await input('../workspace.tar.gz')).statusCode).toBe(404)
    const other = await createDesign(u)
    const otherToken = await issueWorker(other, 'm-other')
    expect((await input(rev.files[0], otherToken)).statusCode).toBe(403)
    const [prompt] = await db.insert(studioJobs).values({ designId: d.id, type: 'prompt', status: 'taken', payload: {} }).returning()
    expect((await input(rev.files[0], token, prompt.id)).statusCode).toBe(404)
  })

  it('a result with the package marks the entitlement ready', async () => {
    const u = await createUser()
    const { d, token } = await paidHat(u)
    const job = await take(token, d.id)
    expect((await upload(token, job.jobId, PACKAGE, Buffer.from('PK-zip'))).statusCode).toBe(204)
    const res = await result(token, job.jobId, { outcome: 'ok', pieces: [{ category: 'hat', files: [PACKAGE], finalize: CHECKS }], costUsd: null })
    expect(res.statusCode).toBe(204)
    const e = await entitlementOf(d.id)
    expect(e).toMatchObject({ status: 'ready', packageKey: jobFileKey(d.id, job.jobId, PACKAGE), checks: CHECKS })
    const [design] = await db.select().from(studioDesigns).where(eq(studioDesigns.id, d.id))
    expect(design.status).toBe('idle')
    expect(await db.select().from(studioUsageDays)).toHaveLength(0)
  })

  it('a missing package fails that piece', async () => {
    const u = await createUser()
    const { d, token } = await paidHat(u)
    const job = await take(token, d.id)
    await result(token, job.jobId, { outcome: 'error', error: 'render failed', pieces: [] })
    expect((await entitlementOf(d.id)).status).toBe('failed')
    const msgs = await db.select().from(studioMessages).where(eq(studioMessages.designId, d.id))
    expect(msgs.map((m) => m.text)).toContain('Packaging Neon hat failed. You can try again at no charge.')
  })

  it("a finalize job uploads only its package, and other jobs can't upload one", async () => {
    const u = await createUser()
    const { d, token } = await paidHat(u)
    const job = await take(token, d.id)
    expect((await upload(token, job.jobId, 'pieces/hat/neon_male.glb', Buffer.from('x'), 'model/gltf-binary')).statusCode).toBe(400)
    const [prompt] = await db.insert(studioJobs).values({ designId: d.id, type: 'prompt', status: 'taken', payload: {} }).returning()
    expect((await upload(token, prompt.id, PACKAGE, Buffer.from('x'))).statusCode).toBe(400)
  })

  it('a lost finalize job fails its entitlements; retry is free', async () => {
    const u = await createUser()
    const { d, token } = await paidHat(u)
    const job = await take(token, d.id)
    expect(await failJobs([job.jobId], 'The studio machine stopped answering.', new Date())).toBe(1)
    expect((await entitlementOf(d.id)).status).toBe('failed')
    expect((await download(u, d.id)).json().code).toBe('failed')
    const retry = await app.inject({ method: 'POST', url: `/api/studio/designs/${d.id}/pieces/hat/revisions/1/package/retry`, headers: as(u) })
    expect(retry.statusCode).toBe(202)
    const e = await entitlementOf(d.id)
    expect(e.status).toBe('packaging')
    expect(e.jobId).not.toBe(job.jobId)
    const [again] = await db.select().from(studioJobs).where(eq(studioJobs.id, e.jobId!))
    expect(again).toMatchObject({ type: 'finalize', status: 'queued' })
    expect(stripe.calls.sessions).toHaveLength(0)
    const twice = await app.inject({ method: 'POST', url: `/api/studio/designs/${d.id}/pieces/hat/revisions/1/package/retry`, headers: as(u) })
    expect(twice.statusCode).toBe(409)
    expect(twice.json().code).toBe('not_failed')
  })

  it('the owner downloads the zip', async () => {
    const u = await createUser()
    const { d, token } = await paidHat(u)
    const job = await take(token, d.id)
    await upload(token, job.jobId, PACKAGE, Buffer.from('PK-the-package'))
    await result(token, job.jobId, { outcome: 'ok', pieces: [{ category: 'hat', files: [PACKAGE], finalize: CHECKS }] })
    const res = await download(u, d.id)
    expect(res.statusCode).toBe(200)
    expect(res.rawPayload.toString()).toBe('PK-the-package')
    expect(res.headers['content-type']).toBe('application/zip')
    expect(res.headers['content-disposition']).toBe('attachment; filename="neon-hat-r1.zip"')
    expect(res.headers['cache-control']).toBe('private, no-store')
  })

  it('another user gets 404; an unpaid revision is 402; packaging is 409', async () => {
    const u = await createUser()
    const { d } = await paidHat(u)
    expect((await download(await createUser(), d.id)).statusCode).toBe(404)
    const packaging = await download(u, d.id)
    expect(packaging.statusCode).toBe(409)
    expect(packaging.json().code).toBe('packaging')
    await addRevision(d, 'hat')
    const unpaid = await download(u, d.id, 2)
    expect(unpaid.statusCode).toBe(402)
    expect(unpaid.json().code).toBe('not_paid')
  })

  it('designDetail lists finalized revisions without links', async () => {
    const u = await createUser()
    const { d } = await paidHat(u)
    const res = await app.inject({ method: 'GET', url: `/api/studio/designs/${d.id}`, headers: as(u) })
    const body = res.json()
    expect(body.design.finalizedAt).not.toBeNull()
    const hat = body.pieces.find((p: any) => p.category === 'hat')
    expect(hat.finalized).toEqual([expect.objectContaining({ revision: 1, kind: 'first', status: 'packaging', amountCents: 2900, report: null })])
    expect(hat.finalized[0].paidAt).toBeTruthy()
    expect(hat.finalized[0].reportableUntil).toBeNull() // a first finalize can't be reported
    expect(JSON.stringify(body)).not.toMatch(/package|packageKey/)
  })
})
