import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { hyperfyWorlds, analyticsScenes, analyticsSessions, analyticsPositions, locationSetups } from '../src/db/schema.js'
import { createWorldKey } from '../src/hyperfy/worlds.js'
import { visitorHash } from '../src/analytics/hash.js'
import { resetDb } from './helpers/db.js'
import { createUser, createScene, testApp } from './helpers/factories.js'

describe('POST /api/hyperfy/analytics', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let sceneId: string
  let worldId: string
  let key: string

  beforeEach(async () => {
    await resetDb()
    app = await testApp()
    const owner = await createUser()
    const { scene } = await createScene(owner, 'World')
    sceneId = scene.id
    const k = createWorldKey()
    key = k.raw
    const [w] = await db.insert(hyperfyWorlds).values({ sceneId, ownerId: owner.id, name: 'Moon Base', keyHash: k.hash, keyPrefix: k.prefix }).returning()
    worldId = w.id
  })
  afterEach(async () => {
    await app.close()
  })

  const post = (body: unknown, k: string | null = key) =>
    app.inject({ method: 'POST', url: '/api/hyperfy/analytics', headers: k ? { authorization: `Bearer ${k}` } : {}, payload: body as object })

  const T = Date.now() - 60_000
  const goodBatch = () => ({
    v: 1,
    events: [
      { type: 'enter', playerId: 'p1', t: T },
      { type: 'pos', playerId: 'p1', t: T + 5000, x: 1, y: 2, z: 3 },
      { type: 'leave', playerId: 'p1', t: T + 12_000 },
    ],
  })

  it('a batch of enter, pos, leave creates one unverified session with a position and a duration', async () => {
    const res = await post(goodBatch())
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ accepted: 3 })
    const sessions = await db.select().from(analyticsSessions)
    expect(sessions).toHaveLength(1)
    const s = sessions[0]
    expect(s.verified).toBe(false)
    expect(s.isGuest).toBe(true)
    expect(s.platform).toBe('hyperfy')
    expect(s.displayName).toBeNull()
    expect(s.wallet).toBeNull()
    expect(s.durationSec).toBe(12)
    expect(s.endedAt?.getTime()).toBe(T + 12_000)
    const [scene] = await db.select().from(analyticsScenes)
    expect(s.visitorHash).toBe(visitorHash(scene.salt, 'hyperfy:p1'))
    const pos = await db.select().from(analyticsPositions)
    expect(pos).toHaveLength(1)
    expect([pos[0].x, pos[0].y, pos[0].z]).toEqual([1, 2, 3])
    // resending the same batch adds nothing and keeps one session
    const again = await post(goodBatch())
    expect(again.json()).toEqual({ accepted: 0 })
    expect(await db.select().from(analyticsSessions)).toHaveLength(1)
  })

  it('a leave in a later batch closes the session opened earlier', async () => {
    await post({ v: 1, events: [{ type: 'enter', playerId: 'p1', t: T }] })
    await post({ v: 1, events: [{ type: 'leave', playerId: 'p1', t: T + 9000 }] })
    const [s] = await db.select().from(analyticsSessions)
    expect(s.durationSec).toBe(9)
    expect(s.endedAt).not.toBeNull()
  })

  it('the world gets one analytics location linked to its scene', async () => {
    await post(goodBatch())
    await post({ v: 1, events: [{ type: 'enter', playerId: 'p2', t: T + 100 }] })
    const scenes = await db.select().from(analyticsScenes)
    expect(scenes).toHaveLength(1)
    expect(scenes[0]).toMatchObject({ kind: 'hyperfy', locationKey: `hyperfy:${worldId}`, title: 'Moon Base', vlmSceneId: sceneId })
    const setups = await db.select().from(locationSetups).where(eq(locationSetups.analyticsSceneId, scenes[0].id))
    expect(setups).toHaveLength(1)
    expect(setups[0].vlmSceneId).toBe(sceneId)
    expect(await db.select().from(analyticsSessions)).toHaveLength(2)
  })

  it('401 for a bad key', async () => {
    expect((await post(goodBatch(), 'vlmw_nope')).statusCode).toBe(401)
    expect((await post(goodBatch(), null)).statusCode).toBe(401)
    expect(await db.select().from(analyticsScenes)).toHaveLength(0)
  })

  it('rejects an invalid batch', async () => {
    const res = await post({ v: 1, events: [{ type: 'dance', playerId: 'p1', t: T }] })
    expect(res.statusCode).toBe(400)
    const stale = await post({ v: 1, events: [{ type: 'enter', playerId: 'p1', t: Date.now() - 25 * 3600_000 }] })
    expect(stale.statusCode).toBe(400)
    expect(stale.json().error).toMatch(/event\.t/)
    expect(await db.select().from(analyticsSessions)).toHaveLength(0)
  })
})
