import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { hyperfyWorlds, subscriptions } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { createHostedWorld, hostedWorldSettled, restoreHostedWorld } from '../src/hyperfy/hosting.js'
import { createWorldKey } from '../src/hyperfy/worlds.js'
import { hostedWorldSlots } from '../src/hyperfy/slots.js'
import { sweepHostedWorlds, SWEEP_INTERVAL_MS, type SweepDeps } from '../src/hyperfy/sweep.js'
import { resetDb } from './helpers/db.js'
import { createUser, createScene, type TestUser } from './helpers/factories.js'

const CONFIG = {
  hyperfyImage: 'registry.fly.io/vlm-hyperfy-image:abc123',
  hyperfyAssetsS3Uri: 's3://r2key:r2s3cr3t@acct.r2.cloudflarestorage.com/virvi-hyperfy',
  hyperfyAssetsBaseUrl: 'https://worlds-cdn.virvi.io',
  hyperfyRouterDomain: 'worlds.virvi.io',
  hyperfySecretKey: 'ab'.repeat(32),
  publicUrl: 'https://api.virvi.io',
  allFeaturesUnlocked: false,
}
const MIN = 60_000
const DAY = 24 * 60 * MIN

function fakes(opts: { failStop?: Set<string>; failDestroy?: Set<string>; failDrop?: Set<string>; asleep?: Set<string>; failUpdate?: Set<string>; onList?: (app: string) => void } = {}) {
  let listCalls = 0
  const stopped: string[] = []
  const updates: { app: string; autostart: boolean | undefined; env: Record<string, string>; image: string }[] = []
  const started: string[] = []
  const deletedApps: string[] = []
  const droppedDbs: string[] = []
  const deletedFiles: string[] = []
  const logs: string[] = []
  const machines = new Map<string, { id: string; state: string }>()
  const machine = (app: string) => {
    if (!machines.has(app)) machines.set(app, { id: `m-${app}`, state: opts.asleep?.has(app) ? 'stopped' : 'started' })
    return machines.get(app)!
  }
  const deps: Partial<SweepDeps> = {
    fly: {
      async listMachines(app: string) { listCalls++; opts.onList?.(app); return [{ ...machine(app) }] },
      async getMachineEnv() { return { VLM_WORLD_KEY: 'k' } },
      async updateMachine(app: string, _id: string, m: { image: string; env: Record<string, string>; autostart?: boolean }) {
        if (opts.failUpdate?.has(app) && m.autostart === false) throw new Error('fly down')
        updates.push({ app, autostart: m.autostart, env: m.env, image: m.image })
      },
      async stopMachine(app: string, id: string) {
        if (opts.failStop?.has(app)) throw new Error('fly down')
        machine(app).state = 'stopped'
        stopped.push(`${app}/${id}`)
      },
      async startMachine(app: string) { started.push(app); machine(app).state = 'started' },
      async deleteApp(app: string) {
        if (opts.failDestroy?.has(app)) throw new Error('fly down')
        deletedApps.push(app)
      },
      async createApp() {}, async allocatePublicIps() {}, async allocatePrivateIp() {}, async createMachine() { return { id: 'x' } },
    },
    async createWorldDatabase(slug: string) { return { dbUri: 'postgres://u:pw_secret_x@h/db', schema: slug } },
    async dropWorldDatabase(slug: string) {
      if (opts.failDrop?.has(slug)) throw new Error('db down')
      droppedDbs.push(slug)
    },
    async deleteWorldFiles(slug: string) { deletedFiles.push(slug); return 0 },
    fetch: (async () => new Response('', { status: 200 })) as unknown as typeof fetch,
    sleep: async () => {},
    log: {
      info: (...a: unknown[]) => { logs.push(JSON.stringify(a)) },
      warn: (...a: unknown[]) => { logs.push(JSON.stringify(a)) },
      error: (...a: unknown[]) => { logs.push(JSON.stringify(a)) },
    },
  }
  return { deps, listCalls: () => listCalls, stopped, updates, started, machines, deletedApps, droppedDbs, deletedFiles, logs }
}

describe('hosted world sweep', () => {
  let owner: TestUser
  let sceneId: string
  const saved: Record<string, unknown> = {}
  const now = new Date('2026-11-01T12:00:00Z')
  const row = async (id: string) => (await db.select().from(hyperfyWorlds).where(eq(hyperfyWorlds.id, id)))[0]

  const insert = async (slug: string, v: Partial<typeof hyperfyWorlds.$inferInsert> = {}) => {
    const key = createWorldKey()
    const [w] = await db
      .insert(hyperfyWorlds)
      .values({
        sceneId, ownerId: owner.id, name: slug, kind: 'hosted', keyHash: key.hash, keyPrefix: key.prefix,
        slug, address: `vlm-w-${slug}.fly.dev`, flyApp: `vlm-w-${slug}`, status: 'running', ...v,
      })
      .returning()
    return w
  }

  beforeEach(async () => {
    await resetDb()
    owner = await createUser()
    sceneId = (await createScene(owner, 'World')).scene.id
    await db.insert(subscriptions).values({ userId: owner.id, tier: 'creator' })
    for (const [k, v] of Object.entries(CONFIG)) {
      saved[k] = (config as any)[k]
      ;(config as any)[k] = v
    }
  })
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) (config as any)[k] = v
  })

  it('a running world past its end date ends, stops its machines and frees its slot', async () => {
    const due = await insert('due-world', { endsAt: new Date(now.getTime() - MIN) })
    const later = await insert('later-world', { endsAt: new Date(now.getTime() + DAY) })
    const forever = await insert('forever-world')
    const f = fakes()
    expect(await hostedWorldSlots(owner.id)).toMatchObject({ used: 3 })

    const result = await sweepHostedWorlds(now, f.deps)

    expect(result).toEqual({ ended: 1, purged: 0, stuck: 0 })
    const ended = await row(due.id)
    expect(ended.status).toBe('ended')
    expect(ended.endedAt).toEqual(now)
    expect(ended.purgeAfter).toEqual(new Date(now.getTime() + 30 * DAY))
    expect(f.stopped).toEqual(['vlm-w-due-world/m-vlm-w-due-world'])
    expect(f.updates).toEqual([{ app: 'vlm-w-due-world', autostart: false, env: { VLM_WORLD_KEY: 'k' }, image: CONFIG.hyperfyImage }])
    expect((await row(later.id)).status).toBe('running')
    expect((await row(forever.id)).status).toBe('running')
    expect(await hostedWorldSlots(owner.id)).toMatchObject({ used: 2 })
  })

  it('a machine that will not stop does not stop the sweep for other worlds', async () => {
    await insert('bad-world', { endsAt: new Date(now.getTime() - 2 * MIN) })
    const good = await insert('good-world', { endsAt: new Date(now.getTime() - MIN) })
    const f = fakes({ failStop: new Set(['vlm-w-bad-world']) })

    const result = await sweepHostedWorlds(now, f.deps)

    expect(result.ended).toBe(2)
    expect(f.stopped).toEqual(['vlm-w-good-world/m-vlm-w-good-world'])
    expect((await row(good.id)).status).toBe('ended')
    expect(f.logs.join('\n')).toContain('vlm-w-bad-world')
  })

  it('concurrent sweeps end a world exactly once', async () => {
    await insert('race-world', { endsAt: new Date(now.getTime() - MIN) })
    const f = fakes()
    const results = await Promise.all([sweepHostedWorlds(now, f.deps), sweepHostedWorlds(now, f.deps), sweepHostedWorlds(now, f.deps)])
    expect(results.reduce((n, r) => n + r.ended, 0)).toBe(1)
    expect(f.stopped).toHaveLength(1)
  })

  it('an asleep world gets autostart off and no stop call', async () => {
    await insert('nap-world', { endsAt: new Date(now.getTime() - MIN) })
    const f = fakes({ asleep: new Set(['vlm-w-nap-world']) })
    await sweepHostedWorlds(now, f.deps)
    expect(f.updates.map((u) => u.autostart)).toEqual([false])
    expect(f.stopped).toEqual([])
  })

  it('a failed stop is retried on the next sweep, and an ended world already stopped is left alone', async () => {
    const w = await insert('retry-world', { endsAt: new Date(now.getTime() - MIN) })
    const bad = fakes({ failStop: new Set(['vlm-w-retry-world']) })
    expect((await sweepHostedWorlds(now, bad.deps)).ended).toBe(1)
    expect(bad.stopped).toEqual([])

    const next = fakes()
    const later = new Date(now.getTime() + SWEEP_INTERVAL_MS)
    expect((await sweepHostedWorlds(later, next.deps)).ended).toBe(0)
    expect(next.stopped).toEqual(['vlm-w-retry-world/m-vlm-w-retry-world'])
    expect(next.updates.map((u) => u.autostart)).toEqual([false])
    expect((await row(w.id)).endedAt).toEqual(now)

    const quiet = fakes({ asleep: new Set(['vlm-w-retry-world']) })
    await sweepHostedWorlds(new Date(later.getTime() + SWEEP_INTERVAL_MS), quiet.deps)
    expect(quiet.updates).toEqual([])
    expect(quiet.stopped).toEqual([])
  })

  it('a quiesced world is skipped by later sweeps; one whose autostart update failed is retried, stopped machine included', async () => {
    const w = await insert('calm-world', { endsAt: new Date(now.getTime() - MIN) })
    const asleep = new Set(['vlm-w-calm-world'])
    const bad = fakes({ asleep, failUpdate: new Set(['vlm-w-calm-world']) })
    await sweepHostedWorlds(now, bad.deps)
    expect((await row(w.id)).quiescedAt).toBeNull()

    const retry = fakes({ asleep })
    await sweepHostedWorlds(new Date(now.getTime() + SWEEP_INTERVAL_MS), retry.deps)
    expect(retry.updates.map((u) => u.autostart)).toEqual([false])
    expect(retry.stopped).toEqual([])
    expect((await row(w.id)).quiescedAt).not.toBeNull()

    const quiet = fakes({ asleep })
    await sweepHostedWorlds(new Date(now.getTime() + 2 * SWEEP_INTERVAL_MS), quiet.deps)
    expect(quiet.listCalls()).toBe(0)
  })

  it('a restore that lands while the sweep is quiescing waits for it and wins: the world ends up running with autostart on', async () => {
    const w = await insert('race-back', { endsAt: new Date(now.getTime() - MIN), purgeAfter: new Date(Date.now() + DAY) })
    let restored: Promise<unknown> | undefined
    let hooked = false
    const f = fakes({
      onList: () => {
        if (hooked) return
        hooked = true
        // The owner restores while the sweep holds the world; restore must queue behind it, not interleave.
        restored = restoreHostedWorld(w.id, f.deps).catch((e) => e)
      },
    })
    await sweepHostedWorlds(now, f.deps)
    const outcome = await restored
    expect(outcome).toMatchObject({ status: 'running' })
    expect(f.updates.map((u) => u.autostart)).toEqual([false, true])
    expect(f.machines.get('vlm-w-race-back')!.state).toBe('started')
    const after = await row(w.id)
    expect(after.status).toBe('running')
    expect(after.quiescedAt).toBeNull()
  })

  it('a world restored before the sweep gets to it is left alone', async () => {
    const w = await insert('back-first', { endsAt: new Date(now.getTime() - MIN) })
    const f = fakes()
    // Another server's sweep ended it, then the owner restored it, between our read and our lock.
    await db.update(hyperfyWorlds).set({ status: 'ended', endedAt: now, purgeAfter: new Date(Date.now() + DAY) }).where(eq(hyperfyWorlds.id, w.id))
    await restoreHostedWorld(w.id, f.deps)
    f.updates.length = 0
    f.stopped.length = 0
    await sweepHostedWorlds(now, f.deps)
    expect(f.updates).toEqual([])
    expect(f.stopped).toEqual([])
    expect((await row(w.id)).status).toBe('running')
  })

  it('restore leaves an existing world secret (hash and env) alone', async () => {
    const w = await insert('back-secret', { status: 'ended', endedAt: now, purgeAfter: new Date(Date.now() + DAY), worldSecretHash: 'h'.repeat(64) })
    const f = fakes()
    await restoreHostedWorld(w.id, f.deps)
    expect(f.updates[0].env).toEqual({ VLM_WORLD_KEY: 'k' })
    expect((await row(w.id)).worldSecretHash).toBe('h'.repeat(64))
  })

  it('logs an ended world that has no Fly app', async () => {
    await insert('no-app', { endsAt: new Date(now.getTime() - MIN), flyApp: null })
    const f = fakes()
    expect((await sweepHostedWorlds(now, f.deps)).ended).toBe(1)
    expect(f.logs.join('\n')).toContain('hosted world ended')
  })

  it('restore turns autostart back on before starting the machines', async () => {
    const w = await insert('back-world', { status: 'ended', endedAt: now, purgeAfter: new Date(Date.now() + DAY) })
    const f = fakes({ asleep: new Set(['vlm-w-back-world']) })
    await restoreHostedWorld(w.id, f.deps)
    // An existing world with no secret yet gets one on this update (ruling R7)
    const stored = (await row(w.id)).worldSecretHash
    expect(f.updates).toEqual([{ app: 'vlm-w-back-world', autostart: true, env: { VLM_WORLD_KEY: 'k', VLM_WORLD_SECRET: expect.stringMatching(/^[0-9a-f]{64}$/) }, image: CONFIG.hyperfyImage }])
    expect(stored).toBe(createHash('sha256').update(f.updates[0].env.VLM_WORLD_SECRET).digest('hex'))
    expect(f.started).toEqual(['vlm-w-back-world'])
    expect((await row(w.id)).status).toBe('running')
  })

  it('restore refuses a world whose purge has been claimed', async () => {
    const w = await insert('claimed', { status: 'ended', endedAt: now, purgeAfter: new Date(Date.now() + DAY), purgeClaimedAt: now })
    const err = await restoreHostedWorld(w.id, fakes().deps).catch((e) => e)
    expect(err).toMatchObject({ code: 'not_restorable' })
    expect((await row(w.id)).status).toBe('ended')
  })

  it('ended worlds are purged after 30 days, not before', async () => {
    const w = await insert('old-world', { status: 'ended', endedAt: now, purgeAfter: new Date(now.getTime() + 30 * DAY) })

    expect((await sweepHostedWorlds(new Date(now.getTime() + 30 * DAY - MIN), fakes({ asleep: new Set(['vlm-w-old-world']) }).deps)).purged).toBe(0)
    expect(await row(w.id)).toBeDefined()

    const f = fakes({ asleep: new Set(['vlm-w-old-world']) })
    const result = await sweepHostedWorlds(new Date(now.getTime() + 30 * DAY), f.deps)
    expect(result.purged).toBe(1)
    expect(await row(w.id)).toBeUndefined()
    expect(f.deletedApps).toEqual(['vlm-w-old-world'])
    expect(f.droppedDbs).toEqual(['old-world'])
    expect(f.deletedFiles).toEqual(['old-world'])
  })

  it('concurrent sweeps purge a world exactly once', async () => {
    await insert('once-world', { status: 'ended', endedAt: now, purgeAfter: now })
    const f = fakes({ asleep: new Set(['vlm-w-once-world']) })
    const results = await Promise.all([sweepHostedWorlds(now, f.deps), sweepHostedWorlds(now, f.deps), sweepHostedWorlds(now, f.deps)])
    expect(results.reduce((n, r) => n + r.purged, 0)).toBe(1)
    expect(f.deletedApps).toEqual(['vlm-w-once-world'])
  })

  it('a purge that fails keeps the slug taken, is logged, and is retried after one sweep interval', async () => {
    const at = new Date(now.getTime() + 31 * DAY)
    const w = await insert('stuck-purge', { status: 'ended', endedAt: now, purgeAfter: new Date(now.getTime() + 30 * DAY) })
    const asleep = new Set(['vlm-w-stuck-purge'])
    const failing = fakes({ failDrop: new Set(['stuck-purge']), asleep })

    expect((await sweepHostedWorlds(at, failing.deps)).purged).toBe(0)
    const claimed = await row(w.id)
    expect(claimed.purgeClaimedAt).toEqual(at)
    expect(claimed.purgedAt).toBeNull()
    expect(failing.logs.join('\n')).toContain(w.id)

    // The slug is still taken, so a new world with the same name gets -2.
    const f2 = fakes()
    const { world } = await createHostedWorld({ ownerId: owner.id, sceneId, name: 'stuck-purge', endsAt: null }, f2.deps)
    await hostedWorldSettled(world.id)
    expect(world.address).toBe('vlm-w-stuck-purge-2.fly.dev')

    // Too soon to retry.
    const soon = fakes({ asleep })
    expect((await sweepHostedWorlds(new Date(at.getTime() + SWEEP_INTERVAL_MS - 1), soon.deps)).purged).toBe(0)
    expect(soon.deletedApps).toEqual([])

    const retry = fakes({ asleep })
    expect((await sweepHostedWorlds(new Date(at.getTime() + SWEEP_INTERVAL_MS + 1), retry.deps)).purged).toBe(1)
    expect(await row(w.id)).toBeUndefined()
    expect(retry.deletedApps).toEqual(['vlm-w-stuck-purge'])
    expect((await row(world.id)).status).toBe('running')
  })

  it('a world left in provisioning past the health wait is marked failed by the sweep', async () => {
    const old = await insert('slow-world', { status: 'provisioning', createdAt: new Date(now.getTime() - 11 * MIN) })
    const fresh = await insert('fresh-world', { status: 'provisioning', createdAt: new Date(now.getTime() - 5 * MIN) })
    const f = fakes()

    const result = await sweepHostedWorlds(now, f.deps)

    expect(result).toEqual({ ended: 0, purged: 0, stuck: 1 })
    expect(await row(old.id)).toMatchObject({ status: 'failed', errorMessage: "Setup didn't finish in time" })
    expect((await row(fresh.id)).status).toBe('provisioning')
    expect(f.deletedApps).toEqual(['vlm-w-slow-world'])
    expect(f.droppedDbs).toEqual(['slow-world'])
    expect(f.deletedFiles).toEqual(['slow-world'])
    expect(await hostedWorldSlots(owner.id)).toMatchObject({ used: 1 })
  })

  describe('orphaned DB job machines', () => {
    const JOBS = 'vlm-worlds-db-jobs'
    const ago = (ms: number) => new Date(now.getTime() - ms).toISOString()
    const jobMachines = [
      { id: 'old-stopped', state: 'stopped', name: 'db-job-aaa', createdAt: ago(11 * MIN) },
      { id: 'old-created', state: 'created', name: 'db-job-bbb', createdAt: ago(60 * MIN) },
      { id: 'old-failed-delete', state: 'stopped', name: 'db-job-ccc', createdAt: ago(30 * MIN) },
      { id: 'old-started', state: 'started', name: 'db-job-ddd', createdAt: ago(30 * MIN) },
      { id: 'old-starting', state: 'starting', name: 'db-job-eee', createdAt: ago(30 * MIN) },
      { id: 'young-stopped', state: 'stopped', name: 'db-job-fff', createdAt: ago(5 * MIN) },
      { id: 'no-date', state: 'stopped', name: 'db-job-ggg' },
      { id: 'not-a-job', state: 'stopped', name: 'something-else', createdAt: ago(60 * MIN) },
    ]

    const withJobs = (f: ReturnType<typeof fakes>) => {
      const deleted: string[] = []
      const listed: string[] = []
      const fly = f.deps.fly as any
      const listWorld = fly.listMachines
      fly.listMachines = async (app: string) => {
        listed.push(app)
        return app === JOBS ? jobMachines.map((m) => ({ ...m })) : listWorld(app)
      }
      fly.deleteMachine = async (app: string, id: string) => {
        if (id === 'old-failed-delete') throw new Error('fly down')
        deleted.push(`${app}/${id}`)
      }
      return { deleted, listed }
    }

    it('in fly-job mode the sweep force-deletes stopped job machines older than 10 minutes, logging only ids', async () => {
      const savedMode = (config as any).hyperfyWorldsDbMode
      const savedApp = (config as any).hyperfyDbJobApp
      ;(config as any).hyperfyWorldsDbMode = 'fly-job'
      ;(config as any).hyperfyDbJobApp = JOBS
      try {
        const f = fakes()
        const { deleted } = withJobs(f)
        expect(await sweepHostedWorlds(now, f.deps)).toEqual({ ended: 0, purged: 0, stuck: 0 })
        expect(deleted).toEqual([`${JOBS}/old-stopped`, `${JOBS}/old-created`])
        const logText = f.logs.join('\n')
        expect(logText).toContain('old-stopped')
        expect(logText).toContain('old-failed-delete')
        expect(logText).not.toMatch(/PASSWORD|DB_STATEMENTS/)
      } finally {
        ;(config as any).hyperfyWorldsDbMode = savedMode
        ;(config as any).hyperfyDbJobApp = savedApp
      }
    })

    it('a failure listing the jobs app is logged and does not stop the sweep', async () => {
      const savedMode = (config as any).hyperfyWorldsDbMode
      ;(config as any).hyperfyWorldsDbMode = 'fly-job'
      try {
        const due = await insert('due-reap', { endsAt: new Date(now.getTime() - MIN) })
        const f = fakes()
        const fly = f.deps.fly as any
        const listWorld = fly.listMachines
        fly.listMachines = async (app: string) => {
          if (app === (config as any).hyperfyDbJobApp) throw new Error('fly down')
          return listWorld(app)
        }
        expect(await sweepHostedWorlds(now, f.deps)).toEqual({ ended: 1, purged: 0, stuck: 0 })
        expect((await row(due.id)).status).toBe('ended')
        expect(f.logs.join('\n')).toMatch(/job machines/)
      } finally {
        ;(config as any).hyperfyWorldsDbMode = savedMode
      }
    })

    it('in direct mode the jobs app is not touched', async () => {
      const savedMode = (config as any).hyperfyWorldsDbMode
      ;(config as any).hyperfyWorldsDbMode = 'direct'
      try {
        const f = fakes()
        const { deleted, listed } = withJobs(f)
        await sweepHostedWorlds(now, f.deps)
        expect(listed).not.toContain(JOBS)
        expect(deleted).toEqual([])
      } finally {
        ;(config as any).hyperfyWorldsDbMode = savedMode
      }
    })
  })
})
