import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { studioDesigns, studioFlags, studioJobs, studioMessages, studioScopeEvents } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { memoryStudioStore, setStudioStore } from '../src/studio/store.js'
import { setMachineDeps } from '../src/studio/machines.js'
import { promptStatus } from '../src/studio/quota.js'
import { parseResult } from '../src/studio/results.js'
import { DECLINED_NOTE, maybeFlag, offTopicNote, setFlagMailer } from '../src/studio/scope.js'
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

  it('turn-downs past the flag threshold in the window count', async () => {
    const u = await createUser()
    const d = (await create(u)).json()
    for (let i = 0; i < config.studioFlag.threshold; i++) {
      const jobId = (await prompt(u, d.id)).json().jobId
      await finish(jobId, offTopic(jobId))
    }
    expect((await promptStatus(u.id, new Date())).used).toBe(0)
    const jobId = (await prompt(u, d.id)).json().jobId
    await finish(jobId, offTopic(jobId))
    expect((await promptStatus(u.id, new Date())).used).toBe(1)
    const notes = await systemNotes(d.id)
    expect(notes.at(-1)).toBe(offTopicNote('coding', true))
    expect(offTopicNote('coding', true)).toBe('The studio only builds Decentraland wearables and emotes, so this message (coding help) wasn’t sent to the agent. It counted as a prompt, because several recent messages weren’t design work.')
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

  describe('flags', () => {
    let mail: { to: string; subject: string; html: string }[]
    const prevFlag = { ...config.studioFlag }
    beforeEach(() => {
      mail = []
      setFlagMailer(async (to, subject, html) => { mail.push({ to, subject, html }); return true })
      ;(config as any).studioFlag = { ...prevFlag, email: 'owner@virvi.test', threshold: 3, windowHours: 24 }
    })
    afterAll(() => {
      setFlagMailer(null)
      ;(config as any).studioFlag = prevFlag
    })

    const HOUR = 3600_000
    async function turnDowns(u: TestUser, n: number, at: Date, d?: { id: string }) {
      const design = d ?? (await create(u)).json()
      for (let i = 0; i < n; i++) {
        await db.insert(studioScopeEvents).values({ userId: u.id, designId: design.id, by: 'check', category: 'coding', note: `note ${i}`, message: `python ${i}`, createdAt: at })
      }
      return design
    }

    it('the third turn-down in a day opens a flag and emails once', async () => {
      const u = await createUser()
      const now = new Date()
      const d = (await create(u)).json()
      for (let i = 0; i < 3; i++) {
        const jobId = (await prompt(u, d.id)).json().jobId
        await finish(jobId, offTopic(jobId, `python help ${i}`))
      }
      const flags = await db.select().from(studioFlags)
      expect(flags).toHaveLength(1)
      expect(flags[0]).toMatchObject({ userId: u.id, status: 'open' })
      expect(mail).toHaveLength(1)
      expect(mail[0].to).toBe('owner@virvi.test')
      expect(mail[0].html).toContain(u.email)
      expect(mail[0].html).toContain('free')
      expect(mail[0].html).toContain('3 turn-downs')
      expect(mail[0].html).toContain('python help 2')
      expect(mail[0].html).toContain('/admin/studio')
      expect(now).toBeTruthy()
    })

    it('a fourth adds to the open flag without another email', async () => {
      const u = await createUser()
      const d = await turnDowns(u, 3, new Date())
      expect(await maybeFlag(u.id, new Date())).toBe('opened')
      await turnDowns(u, 1, new Date(), d)
      expect(await maybeFlag(u.id, new Date())).toBe(null)
      expect(await db.select().from(studioFlags)).toHaveLength(1)
      expect(mail).toHaveLength(1)
    })

    it('two at once open one flag', async () => {
      const u = await createUser()
      await turnDowns(u, 3, new Date())
      const r = await Promise.all([maybeFlag(u.id, new Date()), maybeFlag(u.id, new Date())])
      expect(r.filter((x) => x === 'opened')).toHaveLength(1)
      expect(await db.select().from(studioFlags)).toHaveLength(1)
      expect(mail).toHaveLength(1)
    })

    it('turn-downs older than the window don’t count', async () => {
      const u = await createUser()
      const now = new Date()
      const d = await turnDowns(u, 2, new Date(now.getTime() - 25 * HOUR))
      await turnDowns(u, 2, now, d)
      expect(await maybeFlag(u.id, now)).toBe(null)
    })

    it('after a dismissal only newer turn-downs count', async () => {
      const u = await createUser()
      const now = new Date()
      const d = await turnDowns(u, 3, new Date(now.getTime() - 2 * HOUR))
      await db.insert(studioFlags).values({ userId: u.id, status: 'dismissed', openedAt: new Date(now.getTime() - 2 * HOUR), closedAt: new Date(now.getTime() - HOUR) })
      await turnDowns(u, 2, now, d)
      expect(await maybeFlag(u.id, now)).toBe(null)
      await turnDowns(u, 1, now, d)
      expect(await maybeFlag(u.id, now)).toBe('opened')
    })

    it('a message can’t write html into the owner’s email', async () => {
      const u = await createUser()
      const d = (await create(u)).json()
      for (let i = 0; i < 3; i++) {
        await db.insert(studioScopeEvents).values({ userId: u.id, designId: d.id, by: 'check', category: 'coding', note: 'n', message: '<a href="https://evil.test">click</a>' })
      }
      await maybeFlag(u.id, new Date())
      expect(mail[0].html).not.toContain('<a href="https://evil.test">')
      expect(mail[0].html).toContain('&lt;a href=&quot;https://evil.test&quot;&gt;')
    })

    it('no email address set: the flag opens, nothing is sent', async () => {
      ;(config as any).studioFlag = { ...config.studioFlag, email: null }
      const u = await createUser()
      await turnDowns(u, 3, new Date())
      expect(await maybeFlag(u.id, new Date())).toBe('opened')
      expect(mail).toHaveLength(0)
    })
  })
})
