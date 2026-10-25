import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { studioDesigns, studioJobs, studioMessages } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { sweepStudio } from '../src/studio/sweep.js'
import { applyResult } from '../src/studio/results.js'
import { reservePrompt, promptStatus } from '../src/studio/quota.js'
import { resetDb } from './helpers/db.js'
import { createUser } from './helpers/factories.js'
import { createDesign, fakeFly, queueJob, okResult } from './helpers/studio.js'

const MIN = 60_000
const T0 = new Date('2026-10-25T12:00:00Z')
const at = (ms: number) => new Date(T0.getTime() + ms)

describe('studio sweep', () => {
  const prev = config.studioWorkerImage
  beforeAll(() => { (config as any).studioWorkerImage = 'registry.fly.io/vlm-studio-worker:test' })
  afterAll(() => { (config as any).studioWorkerImage = prev })
  beforeEach(resetDb)

  async function countedTakenPrompt() {
    const owner = await createUser()
    const design = await createDesign(owner, { status: 'building', machineId: 'm1', lastJobAt: T0 })
    const r = await reservePrompt(owner.id, T0, { counted: true })
    await reservePrompt(owner.id, T0, { counted: true }) // an earlier prompt, so a double refund would show
    const job = await queueJob(design, undefined, { counted: true, countedDay: (r as any).day, status: 'taken', takenAt: T0, createdAt: T0 })
    return { owner, design, job }
  }

  it('lost jobs are failed and refunded', async () => {
    const fly = fakeFly()
    const { owner, design, job } = await countedTakenPrompt()
    expect(await sweepStudio(at(26 * MIN), { fly })).toMatchObject({ lost: 0 })
    expect((await db.select().from(studioJobs))[0].status).toBe('taken')
    expect(await sweepStudio(at(41 * MIN), { fly })).toMatchObject({ lost: 1 })
    const [j] = await db.select().from(studioJobs)
    expect(j).toMatchObject({ status: 'failed', result: { outcome: 'error', error: 'The studio machine stopped responding.' } })
    expect((await promptStatus(owner.id, T0)).used).toBe(1)
    const msgs = await db.select().from(studioMessages)
    expect(msgs).toMatchObject([{ role: 'system', jobId: job.id }])
    expect((await db.select().from(studioDesigns).where(eq(studioDesigns.id, design.id)))[0].status).toBe('idle')
    expect(await applyResult(job.id, okResult(job.id) as any, at(42 * MIN))).toBe('already')
  })

  it('a taken render job is lost after 300 s plus 15 minutes', async () => {
    const design = await createDesign(await createUser(), { machineId: 'm1', lastJobAt: T0 })
    await queueJob(design, { type: 'render', limits: { timeoutSec: 300 }, render: {} }, { status: 'taken', takenAt: T0, createdAt: T0 })
    expect((await sweepStudio(at(19 * MIN), { fly: fakeFly() })).lost).toBe(0)
    expect((await sweepStudio(at(21 * MIN), { fly: fakeFly() })).lost).toBe(1)
  })

  it('a queued job nobody took is failed after 10 minutes', async () => {
    const owner = await createUser()
    const design = await createDesign(owner, { status: 'building', machineId: 'm1', lastJobAt: T0 })
    const r = await reservePrompt(owner.id, T0, { counted: true })
    await queueJob(design, undefined, { counted: true, countedDay: (r as any).day, createdAt: T0 })
    expect((await sweepStudio(at(9 * MIN), { fly: fakeFly() })).lost).toBe(0)
    expect((await sweepStudio(at(11 * MIN), { fly: fakeFly() })).lost).toBe(1)
    const [j] = await db.select().from(studioJobs)
    expect(j.result).toMatchObject({ error: 'The studio machine did not start.' })
    expect((await promptStatus(owner.id, T0)).used).toBe(0)
  })

  it('a queued job waiting over a minute gets its machine started again', async () => {
    const fly = fakeFly()
    const design = await createDesign(await createUser(), { status: 'building', lastJobAt: T0 })
    await queueJob(design, undefined, { createdAt: T0 })
    await sweepStudio(at(30_000), { fly })
    expect(fly.calls.create).toHaveLength(0)
    await sweepStudio(at(2 * MIN), { fly })
    expect(fly.calls.create).toHaveLength(1)
  })

  it('idle machines are destroyed after three days, busy ones never', async () => {
    const fly = fakeFly()
    const u = await createUser()
    const idle = await createDesign(u, { machineId: 'm-idle', workerTokenHash: 'h1', lastJobAt: T0 })
    const recent = await createDesign(u, { machineId: 'm-recent', workerTokenHash: 'h2', lastJobAt: at(2 * 24 * 60 * MIN) })
    const busy = await createDesign(u, { machineId: 'm-busy', workerTokenHash: 'h3', lastJobAt: T0 })
    await queueJob(busy, undefined, { status: 'taken', takenAt: at(3 * 24 * 60 * MIN), createdAt: at(3 * 24 * 60 * MIN) })
    const now = at(3 * 24 * 60 * MIN + MIN)
    const r = await sweepStudio(now, { fly })
    expect(r.destroyed).toBe(1)
    expect(fly.calls.del).toEqual(['m-idle'])
    const rows = await db.select().from(studioDesigns)
    expect(rows.find((d) => d.id === idle.id)).toMatchObject({ machineId: null, workerTokenHash: null })
    expect(rows.find((d) => d.id === recent.id)?.machineId).toBe('m-recent')
    expect(rows.find((d) => d.id === busy.id)?.machineId).toBe('m-busy')
  })

  it('two sweeps at once fail each job once', async () => {
    const a = await countedTakenPrompt()
    const b = await countedTakenPrompt()
    const [x, y] = await Promise.all([sweepStudio(at(41 * MIN), { fly: fakeFly() }), sweepStudio(at(41 * MIN), { fly: fakeFly() })])
    expect(x.lost + y.lost).toBe(2)
    expect((await promptStatus(a.owner.id, T0)).used).toBe(1)
    expect((await promptStatus(b.owner.id, T0)).used).toBe(1)
    expect(await db.select().from(studioMessages)).toHaveLength(2)
  })
})
