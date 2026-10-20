import { describe, it, expect, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { hyperfyWorlds, subscriptions } from '../src/db/schema.js'
import { createWorldKey } from '../src/hyperfy/worlds.js'
import { hostedWorldSlots } from '../src/hyperfy/slots.js'
import { sweepHostedWorlds, SWEEP_INTERVAL_MS, type SweepDeps } from '../src/hyperfy/sweep.js'
import { resetDb } from './helpers/db.js'
import { createUser, createScene, type TestUser } from './helpers/factories.js'

const MIN = 60_000
const DAY = 24 * 60 * MIN

function fakes(opts: { failStop?: string[]; failDestroy?: Set<string> } = {}) {
  const stopped: string[] = []
  const deletedApps: string[] = []
  const droppedDbs: string[] = []
  const deletedFiles: string[] = []
  const logs: string[] = []
  const deps: Partial<SweepDeps> = {
    fly: {
      async listMachines(app: string) { return [{ id: `m-${app}`, state: 'started' }] },
      async stopMachine(app: string, id: string) {
        if (opts.failStop?.includes(app)) throw new Error('fly down')
        stopped.push(`${app}/${id}`)
      },
      async deleteApp(app: string) {
        if (opts.failDestroy?.has(app)) throw new Error('fly down')
        deletedApps.push(app)
      },
      async allocatePublicIps() {}, async allocatePrivateIp() {}, async createMachine() { return { id: 'x' } },
      async updateMachine() {}, async getMachineEnv() { return {} }, async startMachine() {},
    },
    async createWorldDatabase(slug: string) { return { dbUri: '', schema: slug } },
    async dropWorldDatabase(slug: string) { droppedDbs.push(slug) },
    async deleteWorldFiles(slug: string) { deletedFiles.push(slug); return 0 },
    log: {
      info: (...a: unknown[]) => { logs.push(JSON.stringify(a)) },
      warn: (...a: unknown[]) => { logs.push(JSON.stringify(a)) },
      error: (...a: unknown[]) => { logs.push(JSON.stringify(a)) },
    },
  }
  return { deps, stopped, deletedApps, droppedDbs, deletedFiles, logs }
}

describe('hosted world sweep', () => {
  let owner: TestUser
  let sceneId: string
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
    expect((await row(later.id)).status).toBe('running')
    expect((await row(forever.id)).status).toBe('running')
    expect(await hostedWorldSlots(owner.id)).toMatchObject({ used: 2 })
  })

  it('a machine that will not stop does not stop the sweep for other worlds', async () => {
    await insert('bad-world', { endsAt: new Date(now.getTime() - 2 * MIN) })
    const good = await insert('good-world', { endsAt: new Date(now.getTime() - MIN) })
    const f = fakes({ failStop: ['vlm-w-bad-world'] })

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

  it('ended worlds are purged after 30 days, not before', async () => {
    const w = await insert('old-world', { status: 'ended', endedAt: now, purgeAfter: new Date(now.getTime() + 30 * DAY) })

    expect((await sweepHostedWorlds(new Date(now.getTime() + 30 * DAY - MIN), fakes().deps)).purged).toBe(0)
    expect(await row(w.id)).toBeDefined()

    const f = fakes()
    const result = await sweepHostedWorlds(new Date(now.getTime() + 30 * DAY), f.deps)
    expect(result.purged).toBe(1)
    expect(await row(w.id)).toBeUndefined()
    expect(f.deletedApps).toEqual(['vlm-w-old-world'])
    expect(f.droppedDbs).toEqual(['old-world'])
    expect(f.deletedFiles).toEqual(['old-world'])
  })

  it('a purge that fails is logged and retried after one sweep interval', async () => {
    const at = new Date(now.getTime() + 31 * DAY)
    const w = await insert('stuck-purge', { status: 'ended', endedAt: now, purgeAfter: new Date(now.getTime() + 30 * DAY) })
    const failing = fakes({ failDestroy: new Set(['vlm-w-stuck-purge']) })

    expect((await sweepHostedWorlds(at, failing.deps)).purged).toBe(0)
    expect((await row(w.id)).purgedAt).toEqual(at)
    expect(failing.logs.join('\n')).toContain(w.id)

    // Too soon to retry.
    const soon = fakes()
    expect((await sweepHostedWorlds(new Date(at.getTime() + SWEEP_INTERVAL_MS - 1), soon.deps)).purged).toBe(0)
    expect(soon.deletedApps).toEqual([])

    const retry = fakes()
    expect((await sweepHostedWorlds(new Date(at.getTime() + SWEEP_INTERVAL_MS + 1), retry.deps)).purged).toBe(1)
    expect(await row(w.id)).toBeUndefined()
    expect(retry.deletedApps).toEqual(['vlm-w-stuck-purge'])
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
})
