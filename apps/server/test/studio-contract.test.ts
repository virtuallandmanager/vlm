import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { studioJobs, studioPieces, studioRenders, studioRevisions } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { initBus } from '../src/realtime/bus.js'
import { memoryStudioStore, setStudioStore, workspaceKey } from '../src/studio/store.js'
import { studioTopic } from '../src/studio/events.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser } from './helpers/factories.js'
import { createDesign, issueWorker, queueJob, PROMPT_PAYLOAD } from './helpers/studio.js'

const { LocalPresence } = createRequire(import.meta.url)('colyseus') as any
const here = dirname(fileURLToPath(import.meta.url))
const DRIVER = resolve(here, '../../studio-worker/e2e/drive_worker.py')
const hasPython = spawnSync('python3', ['-c', 'import PIL'], { stdio: 'ignore' }).status === 0

describe.skipIf(!hasPython)('the studio worker contract', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  const store = memoryStudioStore()
  const prev = config.studioEnabled
  beforeAll(() => { (config as any).studioEnabled = true; setStudioStore(store) })
  afterAll(async () => { (config as any).studioEnabled = prev; setStudioStore(null); await app?.close() })

  it('the python worker completes a prompt and a render against the real routes', async () => {
    await resetDb()
    const presence = new LocalPresence()
    initBus(presence)
    app = await testApp()
    const url = await app.listen({ port: 0, host: '127.0.0.1' })

    const design = await createDesign(await createUser())
    const token = await issueWorker(design)
    const prompt = await queueJob(design, PROMPT_PAYLOAD)
    const events: any[] = []
    await presence.subscribe(studioTopic(design.id), (e: any) => events.push(e))

    const worker = spawn('python3', [DRIVER], {
      env: { ...process.env, VLM_API_URL: url, STUDIO_WORKER_TOKEN: token, STUDIO_DESIGN_ID: design.id, STUDIO_IDLE_EXIT_SEC: '5' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let log = ''
    worker.stdout.on('data', (d) => (log += d))
    worker.stderr.on('data', (d) => (log += d))
    const exited = new Promise<number | null>((r) => worker.on('exit', (code) => r(code)))

    // Once the prompt's revision exists, ask for another view of it, as POST /designs/:id/renders would
    const deadline = Date.now() + 60_000
    let rev: typeof studioRevisions.$inferSelect | undefined
    while (!rev && Date.now() < deadline) {
      ;[rev] = await db.select().from(studioRevisions)
      if (!rev) await new Promise((r) => setTimeout(r, 50))
    }
    expect(rev, log).toBeTruthy()
    const render = await queueJob(design, {
      type: 'render', kind: 'wearable', agent: null, model: null, prompt: null, selectedSlots: null,
      limits: { timeoutSec: 300, maxTurns: 80, costCeilingUsd: 3 },
      render: { categories: ['hat'], bodyShape: 'female', outfit: 'outfit-2', emote: null },
    })
    await db.insert(studioRenders).values({ revisionId: rev!.id, viewKey: 'spin-female-outfit-2', jobId: render.id, status: 'queued' })

    expect(await exited, log).toBe(0)
    const jobs = await db.select().from(studioJobs)
    expect(jobs.find((j) => j.id === prompt.id), log).toMatchObject({ status: 'done', result: { outcome: 'ok' } })
    expect(jobs.find((j) => j.id === render.id), log).toMatchObject({ status: 'done' })
    const [piece] = await db.select().from(studioPieces)
    expect(piece).toMatchObject({ category: 'hat', name: 'Neon Cap', latestRevisionId: rev!.id })
    expect(rev).toMatchObject({ number: 1, jobId: prompt.id, checker: { pass: true } })
    const renders = await db.select().from(studioRenders).where(eq(studioRenders.revisionId, rev!.id))
    expect(renders.find((r) => r.viewKey === 'spin-male-default')).toMatchObject({ status: 'ready', frames: 36 })
    expect(renders.find((r) => r.viewKey === 'spin-female-outfit-2')).toMatchObject({ status: 'ready', frames: 36 })
    expect(await store.get(workspaceKey(design.id))).not.toBeNull()
    const keys = store.keys()
    for (const f of rev!.files) expect(keys).toContain(`designs/${design.id}/jobs/${prompt.id}/${f}`)
    expect(keys.filter((k) => k.startsWith(`designs/${design.id}/jobs/${render.id}/renders/hat/spin-female-outfit-2/`))).toHaveLength(36)
    const phases = events.filter((e) => e.type === 'phase' && e.jobId === prompt.id).map((e) => e.phase)
    expect(phases).toEqual(['building', 'checking', 'rendering', 'saving'])
    expect(events.filter((e) => e.type === 'job' && e.jobId === prompt.id).map((e) => e.status)).toEqual(['taken', 'done'])
  }, 120_000)
})
