import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { db } from '../src/db/connection.js'
import { eq } from 'drizzle-orm'
import { analyticsRollupHourly, analyticsScenes, analyticsSessions, locationSetups, sceneRoles } from '../src/db/schema.js'
import { getAnalyticsAccess } from '../src/analytics/access.js'
import { actorFromClaims } from '../src/auth/actor.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, tokenFor, randomWallet } from './helpers/factories.js'
import { createAnalyticsScene, insertSession } from './helpers/analytics.js'
import { createSetup } from './helpers/setups.js'
import { setDclDirectory } from '../src/analytics/dcl-directory.js'
import { setUpLocation } from '../src/setup/setups.js'
import { FakeDclDirectory } from './helpers/fake-dcl.js'

const DAY = 86400_000
const actorOf = (u: any) => actorFromClaims({ id: u.id, role: u.role, wallet: u.wallet, verified: true } as any)

describe('analytics access by setup tenure', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => {
    await resetDb()
    app = await testApp()
  })
  afterEach(async () => {
    setDclDirectory(null)
    await app.close()
  })

  it('host, co-host, editor, viewer and strangers', async () => {
    const host = await createUser({ wallet: randomWallet() })
    const { scene: vlm } = await createScene(host)
    const loc = await createAnalyticsScene({ locationKey: 'gc:1,1', parcels: ['1,1'] })
    await createSetup(loc.id, vlm.id)
    const [co, ed, vi, st] = await Promise.all([1, 2, 3, 4].map(() => createUser({ wallet: randomWallet() })))
    await db.insert(sceneRoles).values([
      { sceneId: vlm.id, walletAddress: co.wallet!, role: 'cohost' },
      { sceneId: vlm.id, walletAddress: ed.wallet!, role: 'editor' },
      { sceneId: vlm.id, walletAddress: vi.wallet!, role: 'viewer' },
    ])
    expect(await getAnalyticsAccess(actorOf(host), loc.id)).toMatchObject({ canRead: true, canManage: true, canDelete: true })
    expect(await getAnalyticsAccess(actorOf(co), loc.id)).toMatchObject({ canRead: true, canManage: true, canDelete: false })
    expect(await getAnalyticsAccess(actorOf(ed), loc.id)).toMatchObject({ canRead: true, canManage: false, canDelete: false })
    expect(await getAnalyticsAccess(actorOf(vi), loc.id)).toMatchObject({ canRead: true, canManage: false, canDelete: false })
    expect((await getAnalyticsAccess(actorOf(st), loc.id)).canRead).toBe(false)
  })

  it("a new host never sees the previous tenure's sessions; the previous host keeps read-only access to theirs", async () => {
    const oldHost = await createUser({ wallet: randomWallet() })
    const newHost = await createUser({ wallet: randomWallet() })
    const { scene: oldScene } = await createScene(oldHost)
    const { scene: newScene } = await createScene(newHost)
    const loc = await createAnalyticsScene({ locationKey: 'gc:2,2', parcels: ['2,2'] })
    const switchAt = new Date(Date.now() - 5 * DAY)
    await createSetup(loc.id, oldScene.id, { startedAt: new Date(Date.now() - 20 * DAY), endedAt: switchAt })
    await createSetup(loc.id, newScene.id, { startedAt: switchAt })
    const oldAt = new Date(Date.now() - 10 * DAY)
    const newAt = new Date(Date.now() - 1 * DAY)
    oldAt.setUTCMinutes(0, 0, 0)
    newAt.setUTCMinutes(0, 0, 0)
    const oldSession = await insertSession(loc.id, { startedAt: oldAt, lastSeenAt: oldAt, wallet: '0xold', displayName: 'Old' })
    const newSession = await insertSession(loc.id, { startedAt: newAt, lastSeenAt: newAt, wallet: '0xnew', displayName: 'New' })
    await db.insert(analyticsRollupHourly).values([
      { sceneId: loc.id, hour: oldAt, sessions: 7, uniqueVisitors: 7, peakConcurrency: 7, dwellAvgSec: 10 },
      { sceneId: loc.id, hour: newAt, sessions: 3, uniqueVisitors: 3, peakConcurrency: 3, dwellAvgSec: 10 },
    ])

    const sessionsFor = async (u: any) =>
      (await app.inject({ method: 'GET', url: `/api/analytics/locations/${loc.id}/sessions`, headers: { authorization: `Bearer ${tokenFor(u)}` } })).json()
    const mine = await sessionsFor(newHost)
    expect(mine.sessions).toHaveLength(1)
    const theirs = await sessionsFor(oldHost)
    expect(theirs.sessions).toHaveLength(1)
    expect(new Date(theirs.sessions[0].startedAt).getTime()).toBeLessThan(switchAt.getTime())
    const oldAccess = await getAnalyticsAccess(actorOf(oldHost), loc.id)
    expect(oldAccess).toMatchObject({ canRead: true, canManage: false })
    expect(oldAccess.until?.getTime()).toBe(switchAt.getTime())

    const summary = (await app.inject({ method: 'GET', url: `/api/analytics/locations/${loc.id}/summary?from=${new Date(Date.now() - 30 * DAY).toISOString()}`, headers: { authorization: `Bearer ${tokenFor(newHost)}` } })).json()
    expect(summary.sessions).toBe(3)
    const oldSummary = (await app.inject({ method: 'GET', url: `/api/analytics/locations/${loc.id}/summary?from=${new Date(Date.now() - 30 * DAY).toISOString()}`, headers: { authorization: `Bearer ${tokenFor(oldHost)}` } })).json()
    expect(oldSummary.sessions).toBe(7)

    // Turning wallet visibility off clears identities only inside the caller's tenure.
    const patch = await app.inject({ method: 'PATCH', url: `/api/analytics/locations/${loc.id}`, payload: { walletVisibility: false }, headers: { authorization: `Bearer ${tokenFor(newHost)}` } })
    expect(patch.statusCode).toBe(200)
    const byId = async (id: string) => (await db.query.analyticsSessions.findFirst({ where: eq(analyticsSessions.id, id) }))!
    expect(await byId(newSession.id)).toMatchObject({ wallet: null, displayName: null })
    expect(await byId(oldSession.id)).toMatchObject({ wallet: '0xold', displayName: 'Old' })

    const list = (await app.inject({ method: 'GET', url: '/api/analytics/locations', headers: { authorization: `Bearer ${tokenFor(newHost)}` } })).json()
    expect(list.scenes.map((s: any) => s.id)).toEqual([loc.id])
  })
  it('a foreign redeploy seen only by ingest ends the setup on the next analytics read', async () => {
    const dir = new FakeDclDirectory()
    setDclDirectory(dir)
    const host = await createUser({ wallet: randomWallet() })
    const loc = await createAnalyticsScene({ locationKey: 'gc:3,3', parcels: ['3,3'], baseParcel: '3,3', activeEntityId: 'bafyA' })
    const { setup } = await setUpLocation(loc, host.wallet!)
    const before = await getAnalyticsAccess(actorOf(host), loc.id)
    expect(before).toMatchObject({ canRead: true, canManage: true })
    expect(before.until).toBeUndefined()

    // Ingest from the new deployment records its entity on the analytics row; nobody calls /api/setup/status.
    dir.addScene({ entityId: 'bafyNEW', base: '3,3', parcels: ['3,3'] }, randomWallet())
    await db.update(analyticsScenes).set({ activeEntityId: 'bafyNEW' }).where(eq(analyticsScenes.id, loc.id))

    const after = await getAnalyticsAccess(actorOf(host), loc.id)
    expect(after).toMatchObject({ canRead: true, canManage: false, canDelete: false })
    expect(after.until).toBeInstanceOf(Date)
    expect(after.since?.getTime()).toBe(setup.startedAt.getTime())
    expect(await db.query.locationSetups.findFirst({ where: eq(locationSetups.id, setup.id) })).toMatchObject({ endReason: 'redeployed' })
  })

  it('directory down during that check: the setup stays active', async () => {
    const dir = new FakeDclDirectory()
    setDclDirectory(dir)
    const host = await createUser({ wallet: randomWallet() })
    const loc = await createAnalyticsScene({ locationKey: 'gc:4,4', parcels: ['4,4'], baseParcel: '4,4', activeEntityId: 'bafyA' })
    const { setup } = await setUpLocation(loc, host.wallet!)
    await db.update(analyticsScenes).set({ activeEntityId: 'bafyNEW' }).where(eq(analyticsScenes.id, loc.id))
    dir.down = true
    const before = await getAnalyticsAccess(actorOf(host), loc.id)
    expect(before).toMatchObject({ canRead: true, canManage: true })
    expect(before.until).toBeUndefined()
    expect(await db.query.locationSetups.findFirst({ where: eq(locationSetups.id, setup.id) })).toMatchObject({ endedAt: null })
  })

  it('same entity as the setup: no directory calls', async () => {
    const dir = new FakeDclDirectory()
    setDclDirectory(dir)
    const host = await createUser({ wallet: randomWallet() })
    const loc = await createAnalyticsScene({ locationKey: 'gc:5,5', parcels: ['5,5'], baseParcel: '5,5', activeEntityId: 'bafyA' })
    await setUpLocation(loc, host.wallet!)
    dir.calls = 0
    expect((await getAnalyticsAccess(actorOf(host), loc.id)).canManage).toBe(true)
    expect(dir.calls).toBe(0)
  })
})
