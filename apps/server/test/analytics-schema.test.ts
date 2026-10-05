import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { db } from '../src/db/connection.js'
import { analyticsEvents, sceneCollaborators } from '../src/db/schema.js'
import { getAnalyticsAccess } from '../src/analytics/access.js'
import { actorFromClaims } from '../src/auth/actor.js'
import { resetDb } from './helpers/db.js'
import { createUser, createScene, tokenFor, testApp, type TestUser } from './helpers/factories.js'
import { createAnalyticsScene, insertSession } from './helpers/analytics.js'

const actor = (u: TestUser, extra = {}) => actorFromClaims({ id: u.id, role: u.role, wallet: u.wallet, verified: true, ...extra })

describe('analytics schema and access', () => {
  beforeEach(resetDb)

  it('dedupes events on (session_id, seq)', async () => {
    const s = await createAnalyticsScene()
    const row = { sceneId: s.id, sessionId: '11111111-1111-4111-8111-111111111111', seq: 0, visitorHash: 'h', type: 'custom', occurredAt: new Date(), verified: false, data: {} }
    await db.insert(analyticsEvents).values(row).onConflictDoNothing()
    const again = await db.insert(analyticsEvents).values(row).onConflictDoNothing().returning()
    expect(again).toHaveLength(0)
  })

  it('claimer reads and manages; lapsed claimer reads for 30 days only; strangers and unverified get nothing', async () => {
    const claimer = await createUser()
    const stranger = await createUser()
    const s = await createAnalyticsScene({ claimedByUserId: claimer.id, claimStatus: 'active' })
    expect(await getAnalyticsAccess(actor(claimer), s.id)).toMatchObject({ canRead: true, canManage: true })
    expect(await getAnalyticsAccess(actor(stranger), s.id)).toMatchObject({ canRead: false, canManage: false })
    expect(await getAnalyticsAccess(actor(claimer, { verified: false }), s.id)).toMatchObject({ canRead: false })

    const lapsed = await createAnalyticsScene({ claimedByUserId: claimer.id, claimStatus: 'lapsed', lapsedAt: new Date(Date.now() - 10 * 86400_000) })
    expect(await getAnalyticsAccess(actor(claimer), lapsed.id)).toMatchObject({ canRead: true, canManage: false })
    const old = await createAnalyticsScene({ claimedByUserId: claimer.id, claimStatus: 'lapsed', lapsedAt: new Date(Date.now() - 31 * 86400_000) })
    expect(await getAnalyticsAccess(actor(claimer), old.id)).toMatchObject({ canRead: false })
  })

  it('linked VLM scene owner manages, collaborators read', async () => {
    const owner = await createUser()
    const viewer = await createUser()
    const { scene } = await createScene(owner)
    await db.insert(sceneCollaborators).values({ sceneId: scene.id, userId: viewer.id, role: 'viewer' })
    const s = await createAnalyticsScene({ vlmSceneId: scene.id })
    expect(await getAnalyticsAccess(actor(owner), s.id)).toMatchObject({ canRead: true, canManage: true })
    expect(await getAnalyticsAccess(actor(viewer), s.id)).toMatchObject({ canRead: true, canManage: false })
  })
})

describe('compat endpoints keep the dashboard shape', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => {
    await resetDb()
    app = await testApp()
  })
  afterEach(() => app.close())

  it('GET /api/analytics/scenes/:vlmSceneId/recent reads the new tables', async () => {
    const owner = await createUser()
    const { scene } = await createScene(owner)
    const s = await createAnalyticsScene({ vlmSceneId: scene.id })
    await insertSession(s.id, { lastSeenAt: new Date() })
    await insertSession(s.id, { lastSeenAt: new Date(Date.now() - 5 * 60_000), endedAt: new Date(Date.now() - 5 * 60_000) })
    const res = await app.inject({ method: 'GET', url: `/api/analytics/scenes/${scene.id}/recent`, headers: { authorization: `Bearer ${tokenFor(owner)}` } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ visitors: 2, activeSessions: 1 })
    expect(res.json().recentSessions).toHaveLength(2)
  })

  it('returns zeros for a VLM scene with no analytics yet, and 403 for strangers', async () => {
    const owner = await createUser()
    const stranger = await createUser()
    const { scene } = await createScene(owner)
    const ok = await app.inject({ method: 'GET', url: `/api/analytics/scenes/${scene.id}/recent`, headers: { authorization: `Bearer ${tokenFor(owner)}` } })
    expect(ok.json()).toEqual({ visitors: 0, actions: 0, activeSessions: 0, recentSessions: [] })
    const no = await app.inject({ method: 'GET', url: `/api/analytics/scenes/${scene.id}/sessions`, headers: { authorization: `Bearer ${tokenFor(stranger)}` } })
    expect(no.statusCode).toBe(403)
  })
})
