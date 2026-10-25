import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createUnsafeIdentity } from '@dcl/crypto/dist/crypto.js'
import { Wallet } from 'ethers'
import { eq } from 'drizzle-orm'
import { config } from '../src/config.js'
import { db } from '../src/db/connection.js'
import { assetLibraryItems, dclWorldDestinations, sceneDeployments, sceneElements } from '../src/db/schema.js'
import { setWorldsClient, type LiveEntity } from '../src/services/dcl/worlds-client.js'
import { BATCH_WINDOW_MS, startDclRedeploySweep, sweepRedeploys } from '../src/services/dcl/redeploy-sweep.js'
import { DEPLOY_WINDOW_MS, startVirviDeploy, whenSettled } from '../src/services/dcl/world-deployer.js'
import { resetDb } from './helpers/db.js'
import { createElement, createScene, createUser, testApp, tokenFor } from './helpers/factories.js'
import { FakeWorldsClient } from './helpers/fake-worlds.js'

const CDN = 'https://cdn.virvi.test'
const WORLD = 'cafe.dcl.eth'
const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array) => new TextDecoder().decode(b)
const fetcher = vi.fn(async (url: string) => enc(`bytes of ${url}`))
const T0 = new Date('2026-10-25T12:00:00Z')
const at = (s: number) => new Date(T0.getTime() + s * 1000)

let fake: FakeWorldsClient
const cfg = config as { cdnUrl: string | null; virviDclDeployKey: string | null }
let saved: { cdnUrl: string | null; key: string | null }

beforeEach(async () => {
  await resetDb()
  saved = { cdnUrl: cfg.cdnUrl, key: cfg.virviDclDeployKey }
  cfg.cdnUrl = CDN
  cfg.virviDclDeployKey = Wallet.createRandom().privateKey
  fake = new FakeWorldsClient()
  setWorldsClient(fake)
  fetcher.mockClear()
})
afterEach(() => {
  cfg.cdnUrl = saved.cdnUrl
  cfg.virviDclDeployKey = saved.key
  setWorldsClient(null)
})

async function setup(opts: { mode?: 'virvi' | 'sign'; models?: string[] } = {}) {
  const owner = createUnsafeIdentity()
  const user = await createUser({ wallet: owner.address })
  const { scene, preset } = await createScene(user, 'Cafe')
  for (const m of opts.models ?? ['a']) {
    await createElement(preset.id, { type: 'model', name: m, properties: { modelSrc: `${CDN}/m/${m}.glb` } })
  }
  const mode = opts.mode ?? 'virvi'
  const [dest] = await db.insert(dclWorldDestinations).values({
    sceneId: scene.id, ownerUserId: user.id, ownerWallet: owner.address.toLowerCase(), worldName: WORLD,
    base: '0,0', parcels: ['0,0', '1,0'], mode, grantedAt: mode === 'virvi' ? new Date() : null,
  }).returning()
  return { owner, user, scene, preset, dest }
}

const destRow = async (id: string) => (await db.query.dclWorldDestinations.findFirst({ where: eq(dclWorldDestinations.id, id) }))!
const depRow = async (id: string) => (await db.query.sceneDeployments.findFirst({ where: eq(sceneDeployments.id, id) }))!
const deps = () => db.select().from(sceneDeployments)
const addModel = (presetId: string, m: string) =>
  createElement(presetId, { type: 'model', name: m, properties: { modelSrc: `${CDN}/m/${m}.glb` } })

async function sweepAndSettle(now: Date) {
  const r = await sweepRedeploys(now, { fetch: fetcher })
  await Promise.all((await deps()).map((d) => whenSettled(d.id)))
  return r
}

function goLive(i = fake.deployed.length - 1, id?: string) {
  const d = fake.deployed[i]
  const e = JSON.parse(dec(d.files.get(d.entityId)!))
  const live: LiveEntity = { id: id ?? d.entityId, pointers: e.pointers, content: e.content, metadata: e.metadata }
  fake.entities.set(WORLD, [live])
  return live
}

/** A destination that has had its first deploy (model a) and whose live entity is that deploy. */
async function deployedOnce() {
  const s = await setup()
  await sweepAndSettle(at(0))
  await sweepAndSettle(at(61))
  expect(fake.deployed).toHaveLength(1)
  goLive()
  return s
}

describe('sweepRedeploys', () => {
  it('waits out the batch window: not at 30 s, deployed at 61 s', async () => {
    const { dest } = await setup()
    expect(await sweepAndSettle(at(0))).toMatchObject({ started: 0 })
    expect((await destRow(dest.id)).pendingSince).toEqual(at(0))
    await sweepAndSettle(at(30))
    expect(fake.deployed).toHaveLength(0)
    expect(await sweepAndSettle(at(61))).toMatchObject({ started: 1 })
    expect(fake.deployed).toHaveLength(1)
    const d = await destRow(dest.id)
    expect(d.pendingSince).toBeNull()
    expect(d.deployedFiles).toContain('models/vlm/a.glb')
    expect(BATCH_WINDOW_MS).toBe(60_000)
  })

  it('clears pendingSince when nothing is pending', async () => {
    const { dest } = await deployedOnce()
    await db.update(dclWorldDestinations).set({ pendingSince: at(5) }).where(eq(dclWorldDestinations.id, dest.id))
    await sweepAndSettle(at(10))
    expect((await destRow(dest.id)).pendingSince).toBeNull()
    expect(fake.deployed).toHaveLength(1)
  })

  it('two models added 20 s apart make one deployment holding both', async () => {
    const { preset } = await deployedOnce()
    await addModel(preset.id, 'b')
    await sweepAndSettle(at(100))
    await addModel(preset.id, 'c')
    await sweepAndSettle(at(120))
    expect(fake.deployed).toHaveLength(1)
    await sweepAndSettle(at(161))
    expect(fake.deployed).toHaveLength(2)
    const sent = fake.deployed[1]
    const files = JSON.parse(dec(sent.files.get(sent.entityId)!)).content.map((c: { file: string }) => c.file)
    expect(files).toEqual(expect.arrayContaining(['models/vlm/a.glb', 'models/vlm/b.glb', 'models/vlm/c.glb']))
    expect(await deps()).toHaveLength(2)
  })

  it('a World changed outside Virvi becomes needs_review and deploys nothing; rebase then lets the next sweep deploy', async () => {
    const { preset, dest, user } = await deployedOnce()
    await addModel(preset.id, 'b')
    goLive(0, 'someone-elses-entity')
    await sweepAndSettle(at(100))
    await sweepAndSettle(at(161))
    expect(fake.deployed).toHaveLength(1)
    expect(await destRow(dest.id)).toMatchObject({ status: 'needs_review', statusDetail: 'Your World changed outside Virvi' })

    // needs_review stays put: nothing deploys on later sweeps either
    await sweepAndSettle(at(300))
    expect(fake.deployed).toHaveLength(1)

    const app = await testApp()
    try {
      const res = await app.inject({ method: 'POST', url: `/api/dcl/destinations/${dest.id}/rebase`, headers: { authorization: `Bearer ${tokenFor(user)}` }, payload: {} })
      expect(res.statusCode).toBe(200)
    } finally {
      await app.close()
    }
    expect((await destRow(dest.id)).status).toBe('ok')
    await sweepAndSettle(at(400))
    expect(fake.deployed).toHaveLength(2)
  })

  it('an unreadable World is unreachable, and the next sweep after recovery deploys', async () => {
    const { dest } = await setup()
    await sweepAndSettle(at(0))
    fake.down = true
    await sweepAndSettle(at(61))
    expect(fake.deployed).toHaveLength(0)
    expect(await destRow(dest.id)).toMatchObject({ status: 'unreachable' })
    fake.down = false
    await sweepAndSettle(at(91))
    expect(fake.deployed).toHaveLength(1)
    expect((await destRow(dest.id)).status).toBe('ok')
  })

  it('going over the triangle budget is over_budget with no deploy, and clears by itself when the pending set changes', async () => {
    const { preset, dest, scene } = await setup({ models: ['big'] })
    await db.insert(assetLibraryItems).values({ name: 'big', storageKey: 'k1', cdnUrl: `${CDN}/m/big.glb`, triangleCount: 25_000 })
    await sweepAndSettle(at(0))
    await sweepAndSettle(at(61))
    expect(fake.deployed).toHaveLength(0)
    const d = await destRow(dest.id)
    expect(d.status).toBe('over_budget')
    expect(d.statusDetail).toMatch(/triangle/i)
    expect(await deps()).toHaveLength(0)

    // the owner removes the big model: the pending set changes and the status clears
    await db.delete(sceneElements).where(eq(sceneElements.presetId, preset.id))
    await addModel(preset.id, 'small')
    await sweepAndSettle(at(70))
    expect(fake.deployed).toHaveLength(1)
    expect((await destRow(dest.id)).status).toBe('ok')
    expect(scene.id).toBe(dest.sceneId)
  })

  it('says unknown triangle counts were counted as 0 when over budget', async () => {
    const { dest } = await setup({ models: ['big', 'mystery'] })
    await db.insert(assetLibraryItems).values({ name: 'big', storageKey: 'k1', cdnUrl: `${CDN}/m/big.glb`, triangleCount: 25_000 })
    await sweepAndSettle(at(0))
    await sweepAndSettle(at(61))
    expect((await destRow(dest.id)).statusDetail).toMatch(/counted as 0/)
  })

  it('new bytes over the remaining World storage is over_budget', async () => {
    const { dest } = await setup()
    await db.insert(assetLibraryItems).values({ name: 'a', storageKey: 'k1', cdnUrl: `${CDN}/m/a.glb`, triangleCount: 10, fileSizeBytes: 5_000 })
    fake.stats.set(dest.ownerWallet, { maxAllowedBytes: 10_000, usedBytes: 8_000 })
    await sweepAndSettle(at(0))
    await sweepAndSettle(at(61))
    expect(fake.deployed).toHaveLength(0)
    const d = await destRow(dest.id)
    expect(d.status).toBe('over_budget')
    expect(d.statusDetail).toMatch(/storage/i)
  })

  it('a sign destination only gets pendingSince and is never deployed', async () => {
    const { dest } = await setup({ mode: 'sign' })
    await sweepAndSettle(at(0))
    await sweepAndSettle(at(500))
    expect((await destRow(dest.id)).pendingSince).toEqual(at(0))
    expect(fake.deployed).toHaveLength(0)
    expect(await deps()).toHaveLength(0)
  })

  it('does not start a second deploy while one is building', async () => {
    const { dest } = await setup()
    await db.insert(sceneDeployments).values({
      sceneId: dest.sceneId, platform: 'decentraland', deploymentType: 'world', destinationId: dest.id, target: {}, status: 'building', createdAt: at(50),
    })
    await sweepAndSettle(at(0))
    await sweepAndSettle(at(61))
    expect(fake.deployed).toHaveLength(0)
    expect(await deps()).toHaveLength(1)
  })
})

describe('startVirviDeploy refuses a second deploy', () => {
  it.each(['building', 'deploying'] as const)('409 deploy_in_progress while one is %s', async (status) => {
    const { user, dest } = await setup()
    await db.insert(sceneDeployments).values({
      sceneId: dest.sceneId, platform: 'decentraland', deploymentType: 'world', destinationId: dest.id, target: {}, status,
    })
    await expect(startVirviDeploy(dest.id, user.id, { fetch: fetcher })).rejects.toMatchObject({ status: 409, code: 'deploy_in_progress' })
    expect(await deps()).toHaveLength(1)
  })

  it('two starts at once make one deployment', async () => {
    const { user, dest } = await setup()
    const results = await Promise.allSettled([
      startVirviDeploy(dest.id, user.id, { fetch: fetcher }),
      startVirviDeploy(dest.id, user.id, { fetch: fetcher }),
    ])
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    await Promise.all((await deps()).map((d) => whenSettled(d.id)))
    expect(await deps()).toHaveLength(1)
  })
})

describe('stale deployment reconcile (start of each sweep)', () => {
  const stale = (dest: { id: string; sceneId: string }, status: 'building' | 'deploying' | 'awaiting_signature', ageMs: number, bundle?: object) =>
    db.insert(sceneDeployments).values({
      sceneId: dest.sceneId, platform: 'decentraland', deploymentType: 'world', destinationId: dest.id, target: {}, status,
      assetBundle: bundle ?? null, createdAt: new Date(at(0).getTime() - ageMs),
    }).returning().then((r) => r[0])

  it('a stuck row whose entity is live is completed (bookkeeping recovered)', async () => {
    const { dest } = await setup()
    const live: LiveEntity = { id: 'bafyaccepted', pointers: ['0,0', '1,0'], content: [], metadata: {} as LiveEntity['metadata'] }
    fake.entities.set(WORLD, [live])
    const row = await stale(dest, 'deploying', DEPLOY_WINDOW_MS + 1000, { entityId: 'bafyaccepted', deployedFiles: ['scene.json', 'Models/VLM/a.glb'] })
    await sweepAndSettle(at(0))
    expect(await depRow(row.id)).toMatchObject({ status: 'deployed', catalystEntityId: 'bafyaccepted' })
    expect(await destRow(dest.id)).toMatchObject({ lastEntityId: 'bafyaccepted', deployedFiles: ['scene.json', 'models/vlm/a.glb'] })
  })

  it('a stuck row whose entity is not live fails in plain words', async () => {
    const { dest } = await setup({ mode: 'sign' })
    fake.entities.set(WORLD, [{ id: 'other', pointers: ['0,0'], content: [], metadata: {} as LiveEntity['metadata'] }])
    const row = await stale(dest, 'building', DEPLOY_WINDOW_MS + 1000)
    await sweepAndSettle(at(0))
    expect(await depRow(row.id)).toMatchObject({ status: 'failed', errorMessage: 'This deploy was interrupted. Virvi will try again.' })
  })

  it('leaves the row alone when the World cannot be read, and when it is not old enough', async () => {
    const { dest } = await setup({ mode: 'sign' })
    const old = await stale(dest, 'deploying', DEPLOY_WINDOW_MS + 1000)
    const fresh = await stale(dest, 'building', 10_000)
    fake.down = true
    await sweepAndSettle(at(0))
    expect((await depRow(old.id)).status).toBe('deploying')
    expect((await depRow(fresh.id)).status).toBe('building')
    fake.down = false
    await sweepAndSettle(at(1))
    expect((await depRow(old.id)).status).toBe('failed')
    expect((await depRow(fresh.id)).status).toBe('building')
  })

  it('an old awaiting_signature row expires; a recent one stays', async () => {
    const { dest } = await setup({ mode: 'sign' })
    const old = await stale(dest, 'awaiting_signature', DEPLOY_WINDOW_MS + 1000)
    const fresh = await stale(dest, 'awaiting_signature', 30_000)
    await sweepAndSettle(at(0))
    expect(await depRow(old.id)).toMatchObject({ status: 'failed', errorMessage: 'This publish request expired.' })
    expect((await depRow(fresh.id)).status).toBe('awaiting_signature')
  })
})

describe('startDclRedeploySweep', () => {
  it('does nothing at 0 and returns a stopper otherwise', () => {
    startDclRedeploySweep(0)()
    startDclRedeploySweep(60_000)()
  })
})
