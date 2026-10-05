import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { analyticsEvents, sceneCollaborators } from '../src/db/schema.js'
import { getAnalyticsAccess } from '../src/analytics/access.js'
import { actorFromClaims } from '../src/auth/actor.js'
import { resetDb } from './helpers/db.js'
import { createUser, createScene, tokenFor, testApp, type TestUser } from './helpers/factories.js'
import { createAnalyticsScene, insertSession } from './helpers/analytics.js'
import { createSetup } from './helpers/setups.js'

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

  it('open sessions have a partial last_seen_at index for the session-close sweep', async () => {
    const rows = (await db.execute(sql`select indexdef from pg_indexes where tablename = 'analytics_sessions'`)) as unknown as { indexdef: string }[]
    const partial = rows.map((r) => r.indexdef).find((d) => /\(last_seen_at\)/.test(d) && /WHERE \(ended_at IS NULL\)/.test(d))
    expect(partial).toBeDefined()
  })

  it('the active setup host reads, manages and deletes; strangers, unverified users and unset-up locations get nothing', async () => {
    const host = await createUser()
    const stranger = await createUser()
    const { scene } = await createScene(host)
    const s = await createAnalyticsScene()
    await createSetup(s.id, scene.id)
    expect(await getAnalyticsAccess(actor(host), s.id)).toMatchObject({ canRead: true, canManage: true, canDelete: true })
    expect(await getAnalyticsAccess(actor(stranger), s.id)).toMatchObject({ canRead: false, canManage: false, canDelete: false })
    expect(await getAnalyticsAccess(actor(host, { verified: false }), s.id)).toMatchObject({ canRead: false })

    const unset = await createAnalyticsScene({ vlmSceneId: scene.id })
    expect(await getAnalyticsAccess(actor(host), unset.id)).toMatchObject({ canRead: false, canManage: false })
  })

  it('linked VLM scene owner manages, collaborators read', async () => {
    const owner = await createUser()
    const viewer = await createUser()
    const { scene } = await createScene(owner)
    await db.insert(sceneCollaborators).values({ sceneId: scene.id, userId: viewer.id, role: 'viewer' })
    const s = await createAnalyticsScene()
    await createSetup(s.id, scene.id)
    expect(await getAnalyticsAccess(actor(owner), s.id)).toMatchObject({ canRead: true, canManage: true })
    expect(await getAnalyticsAccess(actor(viewer), s.id)).toMatchObject({ canRead: true, canManage: false, canDelete: false })
  })

  it("an ended setup: its host and team read that tenure's data (until endedAt) without managing; admins are unrestricted", async () => {
    const owner = await createUser()
    const viewer = await createUser()
    const admin = await createUser({ role: 'admin' })
    const { scene } = await createScene(owner)
    await db.insert(sceneCollaborators).values({ sceneId: scene.id, userId: viewer.id, role: 'viewer' })
    const startedAt = new Date(Date.now() - 40 * 86400_000)
    const endedAt = new Date(Date.now() - 10 * 86400_000)
    const s = await createAnalyticsScene({ vlmSceneId: scene.id })
    await createSetup(s.id, scene.id, { startedAt, endedAt })
    const ex = await getAnalyticsAccess(actor(owner), s.id)
    expect(ex).toMatchObject({ canRead: true, canManage: false, canDelete: false })
    expect(ex.until?.getTime()).toBe(endedAt.getTime())
    expect(ex.since?.getTime()).toBe(startedAt.getTime())
    const team = await getAnalyticsAccess(actor(viewer), s.id)
    expect(team).toMatchObject({ canRead: true, canManage: false })
    expect(team.until?.getTime()).toBe(endedAt.getTime())
    const adm = await getAnalyticsAccess(actor(admin), s.id)
    expect(adm).toMatchObject({ canRead: true, canManage: true, canDelete: true })
    expect(adm.until).toBeUndefined()
    expect(adm.since).toBeUndefined()
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
    const s = await createAnalyticsScene()
    await createSetup(s.id, scene.id)
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

  it("compat endpoints return 403 once the scene's setup has ended (admins still read)", async () => {
    const owner = await createUser()
    const admin = await createUser({ role: 'admin' })
    const { scene } = await createScene(owner)
    const s = await createAnalyticsScene({ vlmSceneId: scene.id })
    await createSetup(s.id, scene.id, { endedAt: new Date(Date.now() - 86400_000) })
    await insertSession(s.id)
    for (const path of ['recent', 'sessions']) {
      const res = await app.inject({ method: 'GET', url: `/api/analytics/scenes/${scene.id}/${path}`, headers: { authorization: `Bearer ${tokenFor(owner)}` } })
      expect(res.statusCode).toBe(403)
      const adm = await app.inject({ method: 'GET', url: `/api/analytics/scenes/${scene.id}/${path}`, headers: { authorization: `Bearer ${tokenFor(admin)}` } })
      expect(adm.statusCode).toBe(200)
    }
  })

  it('sessions endpoint never leaks visitorHash and exposes a stable 16-hex userId', async () => {
    const owner = await createUser()
    const { scene } = await createScene(owner)
    const s = await createAnalyticsScene()
    await createSetup(s.id, scene.id)
    const hash = 'abcdef0123456789abcdef0123456789'
    await insertSession(s.id, { visitorHash: hash })
    await insertSession(s.id, { visitorHash: hash, wallet: '0xabc' })
    const res = await app.inject({ method: 'GET', url: `/api/analytics/scenes/${scene.id}/sessions`, headers: { authorization: `Bearer ${tokenFor(owner)}` } })
    const { sessions } = res.json()
    expect(sessions).toHaveLength(2)
    for (const r of sessions) {
      expect(r).not.toHaveProperty('visitorHash')
      expect(r.userId).toMatch(/^[0-9a-f]{16}$/)
    }
    expect(sessions[0].userId).toBe(sessions[1].userId)
    expect(sessions.map((r: any) => r.walletAddress).sort()).toEqual(['0xabc', null])
    expect(res.body).not.toContain(hash)
  })
})
