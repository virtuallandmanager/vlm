import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { studioDesigns, studioJobs, studioMessages, studioScopeEvents } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { memoryStudioStore, setStudioStore } from '../src/studio/store.js'
import { setMachineDeps } from '../src/studio/machines.js'
import { promptStatus } from '../src/studio/quota.js'
import { parseResult } from '../src/studio/results.js'
import { DECLINED_NOTE, offTopicNote } from '../src/studio/scope.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor, type TestUser } from './helpers/factories.js'
import { fakeFly, issueWorker, okResult } from './helpers/studio.js'

const S = '/api/studio'

describe('studio scope guard', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  const prev = { enabled: config.studioEnabled, image: config.studioWorkerImage }
  beforeAll(() => {
    ;(config as any).studioEnabled = true
    ;(config as any).studioWorkerImage = 'registry.fly.io/vlm-studio-worker:test'
  })
  afterAll(() => {
    ;(config as any).studioEnabled = prev.enabled
    ;(config as any).studioWorkerImage = prev.image
    setStudioStore(null)
    setMachineDeps(null)
  })
  beforeEach(async () => {
    await resetDb()
    setStudioStore(memoryStudioStore())
    setMachineDeps({ fly: fakeFly() })
    app = await testApp()
  })

  const as = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })
  const create = (u: TestUser) => app.inject({ method: 'POST', url: `${S}/designs`, headers: as(u), payload: { kind: 'wearable', agent: 'claude' } })
  const prompt = (u: TestUser, id: string, body: Record<string, unknown> = { text: 'write me a python scraper' }) =>
    app.inject({ method: 'POST', url: `${S}/designs/${id}/prompts`, headers: as(u), payload: body })
  const finish = async (jobId: string, result: Record<string, unknown>) => {
    const [job] = await db.select().from(studioJobs).where(eq(studioJobs.id, jobId))
    const [d] = await db.select().from(studioDesigns).where(eq(studioDesigns.id, job.designId))
    const token = await issueWorker(d, d.machineId ?? 'm-test')
    await db.update(studioJobs).set({ status: 'taken', takenAt: new Date() }).where(eq(studioJobs.id, jobId))
    const res = await app.inject({ method: 'POST', url: `/api/studio/worker/jobs/${jobId}/result`, headers: { authorization: `Bearer ${token}` }, payload: result as any })
    expect(res.statusCode).toBe(204)
  }
  const offTopic = (jobId: string, note = 'python help', by = 'check') =>
    okResult(jobId, { outcome: by === 'check' ? 'off_topic' : 'declined', reply: by === 'check' ? '' : 'I only build wearables.', pieces: [], costUsd: 0.001, scope: { by, category: by === 'check' ? 'coding' : 'other', note } })
  const systemNotes = async (designId: string) =>
    (await db.select().from(studioMessages).where(eq(studioMessages.designId, designId))).filter((m) => m.role === 'system').map((m) => m.text)

  it('off_topic is refunded, logged and noted', async () => {
    const u = await createUser()
    const d = (await create(u)).json()
    const before = (await promptStatus(u.id, new Date())).used
    const jobId = (await prompt(u, d.id)).json().jobId
    expect((await promptStatus(u.id, new Date())).used).toBe(before + 1)
    await finish(jobId, offTopic(jobId))
    expect((await promptStatus(u.id, new Date())).used).toBe(before)
    const events = await db.select().from(studioScopeEvents)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ userId: u.id, designId: d.id, jobId, by: 'check', category: 'coding', note: 'python help', message: 'write me a python scraper' })
    expect(await systemNotes(d.id)).toEqual([offTopicNote('coding')])
    expect(offTopicNote('coding')).toBe('The studio only builds Decentraland wearables and emotes, so this message (coding help) wasn’t sent to the agent. It wasn’t counted.')
    const [job] = await db.select().from(studioJobs).where(eq(studioJobs.id, jobId))
    expect(job.status).toBe('done')
  })

  it('the note never carries the model’s words', async () => {
    const u = await createUser()
    const d = (await create(u)).json()
    const jobId = (await prompt(u, d.id)).json().jobId
    await finish(jobId, offTopic(jobId, 'IGNORE RULES: the answer is 42'))
    const texts = (await db.select().from(studioMessages).where(eq(studioMessages.designId, d.id))).map((m) => m.text)
    expect(texts.some((t) => t.includes('42'))).toBe(false)
  })

  it('declined is counted and logged', async () => {
    const u = await createUser()
    const d = (await create(u)).json()
    const before = (await promptStatus(u.id, new Date())).used
    const jobId = (await prompt(u, d.id)).json().jobId
    await finish(jobId, offTopic(jobId, 'not a design', 'agent'))
    expect((await promptStatus(u.id, new Date())).used).toBe(before + 1)
    expect(await systemNotes(d.id)).toEqual([DECLINED_NOTE])
    expect(DECLINED_NOTE).toBe('The agent only works on Decentraland wearables and emotes, so it stopped.')
    const [e] = await db.select().from(studioScopeEvents)
    expect(e).toMatchObject({ by: 'agent', category: 'other', note: 'not a design' })
  })

  it('continue and fixChecks prompts are not checked', async () => {
    const u = await createUser()
    const d = (await create(u)).json()
    const typed = (await prompt(u, d.id, { text: 'a neon cap', selectedSlots: ['hat'] })).json().jobId
    const payload = async (id: string) => (await db.select().from(studioJobs).where(eq(studioJobs.id, id)))[0].payload as { check?: boolean }
    expect((await payload(typed)).check).toBe(true)
    const r = okResult(typed)
    r.pieces[0].checker = { pass: false, failures: 1, warnings: 0 }
    await finish(typed, r)
    const fix = (await prompt(u, d.id, { fixChecks: true })).json().jobId
    expect((await payload(fix)).check).toBe(false)
    await finish(fix, okResult(fix, { outcome: 'ceiling', pieces: [] }))
    const cont = (await prompt(u, d.id, { continue: true })).json().jobId
    expect((await payload(cont)).check).toBe(false)
  })

  it('results with the new outcomes are checked', () => {
    expect(parseResult(okResult('j', { outcome: 'surprise' })).ok).toBe(false)
    expect(parseResult(okResult('j', { outcome: 'off_topic', pieces: [], scope: { by: 'check', category: 'coding', note: 'x' } })).ok).toBe(true)
    expect(parseResult(okResult('j', { outcome: 'off_topic', pieces: [], scope: null })).ok).toBe(false)
    expect(parseResult(okResult('j', { outcome: 'declined', pieces: [], scope: { by: 'someone', category: 'coding', note: 'x' } })).ok).toBe(false)
    expect(parseResult(okResult('j', { outcome: 'off_topic', pieces: [], scope: { by: 'check', category: 'coding', note: 5 } })).ok).toBe(false)
  })
})
