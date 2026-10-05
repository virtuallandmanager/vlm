import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { db } from '../src/db/connection.js'
import { sceneRoles } from '../src/db/schema.js'
import { getAnalyticsAccess } from '../src/analytics/access.js'
import { actorFromClaims } from '../src/auth/actor.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, tokenFor, randomWallet } from './helpers/factories.js'
import { createAnalyticsScene, insertSession } from './helpers/analytics.js'
import { createSetup } from './helpers/setups.js'

const DAY = 86400_000
const actorOf = (u: any) => actorFromClaims({ id: u.id, role: u.role, wallet: u.wallet, verified: true } as any)

describe('analytics access by setup tenure', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => {
    await resetDb()
    app = await testApp()
  })
  afterEach(() => app.close())

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
    await insertSession(loc.id, { startedAt: new Date(Date.now() - 10 * DAY), lastSeenAt: new Date(Date.now() - 10 * DAY) })
    await insertSession(loc.id, { startedAt: new Date(Date.now() - 1 * DAY), lastSeenAt: new Date(Date.now() - 1 * DAY) })

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
    expect(JSON.stringify(summary)).not.toContain('"sessions":2')

    const list = (await app.inject({ method: 'GET', url: '/api/analytics/locations', headers: { authorization: `Bearer ${tokenFor(newHost)}` } })).json()
    expect(list.scenes.map((s: any) => s.id)).toEqual([loc.id])
  })
})
