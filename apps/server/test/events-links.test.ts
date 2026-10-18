import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../src/integrations/platform-hooks.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/integrations/platform-hooks.js')>()),
  dispatchPlatformCallbacks: vi.fn(async () => {}),
}))

import { db } from '../src/db/connection.js'
import { events, eventSceneLinks, giveaways } from '../src/db/schema.js'
import { dispatchPlatformCallbacks } from '../src/integrations/platform-hooks.js'
import { resetDb } from './helpers/db.js'
import { createUser, createScene, tokenFor, testApp } from './helpers/factories.js'

const dispatch = vi.mocked(dispatchPlatformCallbacks)

describe('event links and command center REST authorization', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => {
    await resetDb()
    app = await testApp()
    dispatch.mockClear()
  })
  afterEach(() => app.close())

  const call = (user: Awaited<ReturnType<typeof createUser>>, method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${tokenFor(user)}` }, payload: payload as any })

  async function setup() {
    const a = await createUser()
    const b = await createUser()
    const [event] = await db.insert(events).values({ ownerId: a.id, name: 'Festival' }).returning()
    return { a, b, event }
  }

  it('link-scene: own scene 201, another owner\'s scene 404, malformed id 400, admin allowed', async () => {
    const { a, b, event } = await setup()
    const admin = await createUser({ role: 'admin' })
    const { scene: mine } = await createScene(a)
    const { scene: theirs } = await createScene(b)
    expect((await call(a, 'POST', `/api/events/${event.id}/link-scene`, { sceneId: mine.id })).statusCode).toBe(201)
    const res = await call(a, 'POST', `/api/events/${event.id}/link-scene`, { sceneId: theirs.id })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'Scene not found' })
    expect((await call(a, 'POST', `/api/events/${event.id}/link-scene`, { sceneId: 'nope' })).statusCode).toBe(400)
    expect((await call(admin, 'POST', `/api/events/${event.id}/link-scene`, { sceneId: theirs.id })).statusCode).toBe(201)
  })

  it('link-giveaway: another owner\'s giveaway 404, own 201', async () => {
    const { a, b, event } = await setup()
    const [theirs] = await db.insert(giveaways).values({ ownerId: b.id, name: 'G' }).returning()
    const [mine] = await db.insert(giveaways).values({ ownerId: a.id, name: 'G' }).returning()
    expect((await call(a, 'POST', `/api/events/${event.id}/link-giveaway`, { giveawayId: theirs.id })).statusCode).toBe(404)
    expect((await call(a, 'POST', `/api/events/${event.id}/link-giveaway`, { giveawayId: mine.id })).statusCode).toBe(201)
  })

  it('status: owner and admin 200, another account 404', async () => {
    const { a, b, event } = await setup()
    const admin = await createUser({ role: 'admin' })
    expect((await call(b, 'GET', `/api/command-center/${event.id}/status`)).statusCode).toBe(404)
    expect((await call(a, 'GET', `/api/command-center/${event.id}/status`)).statusCode).toBe(200)
    expect((await call(admin, 'GET', `/api/command-center/${event.id}/status`)).statusCode).toBe(200)
  })

  it('broadcast skips scenes the caller does not control, even when linked directly in the DB', async () => {
    const { a, b, event } = await setup()
    const { scene: mine } = await createScene(a)
    const { scene: theirs } = await createScene(b)
    await db.insert(eventSceneLinks).values([{ eventId: event.id, sceneId: mine.id }, { eventId: event.id, sceneId: theirs.id }])
    const res = await call(a, 'POST', `/api/command-center/${event.id}/broadcast`, { action: { presetId: 'x' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().sceneIds).toEqual([mine.id])
    expect(dispatch.mock.calls.map((c) => c[0])).toEqual([mine.id])
  })
})
