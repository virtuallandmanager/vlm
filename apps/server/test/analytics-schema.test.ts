import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { analyticsEvents, sceneCollaborators } from '../src/db/schema.js'
import { getAnalyticsAccess } from '../src/analytics/access.js'
import { actorFromClaims } from '../src/auth/actor.js'
import { resetDb } from './helpers/db.js'
import { createUser, createScene, type TestUser } from './helpers/factories.js'
import { createAnalyticsScene } from './helpers/analytics.js'
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
