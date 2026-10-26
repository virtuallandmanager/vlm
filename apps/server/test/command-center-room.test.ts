import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import { Client } from 'colyseus.js'
import { db } from '../src/db/connection.js'
import { events, eventSceneLinks } from '../src/db/schema.js'
import { VirviCommandCenterRoom } from '../src/ws/VirviCommandCenterRoom.js'
import { resetDb } from './helpers/db.js'
import { createUser, createScene, tokenFor } from './helpers/factories.js'

const _require = createRequire(import.meta.url)
const { Server, LocalPresence } = _require('colyseus') as any
const { WebSocketTransport } = _require('@colyseus/ws-transport') as any

async function join(url: string, eventId: string, token: string) {
  const room = await new Client(url).joinOrCreate('virvi_command_center', { eventId, sessionToken: token })
  const inbox: { type: string; message: any }[] = []
  room.onMessage('*', (type: string | number, message: any) => inbox.push({ type: String(type), message }))
  async function waitFor(type: string, ms = 3000) {
    const start = Date.now()
    while (Date.now() - start < ms) {
      const i = inbox.findIndex((m) => m.type === type)
      if (i >= 0) return inbox.splice(i, 1)[0].message
      await new Promise((r) => setTimeout(r, 20))
    }
    throw new Error(`timed out waiting for ${type}; got ${inbox.map((m) => m.type).join(', ')}`)
  }
  return { room, waitFor }
}

describe('VirviCommandCenterRoom cross_world_update', () => {
  let server: any
  let url: string
  beforeEach(async () => {
    await resetDb()
    server = new Server({ transport: new WebSocketTransport(), presence: new LocalPresence() })
    server.define('virvi_command_center', VirviCommandCenterRoom).filterBy(['eventId'])
    const port = 20000 + Math.floor(Math.random() * 20000)
    await server.listen(port)
    url = `ws://localhost:${port}`
  })
  afterEach(() => server.gracefullyShutdown(false))

  it('only the event owner or a verified admin can fan out updates', async () => {
    const owner = await createUser()
    const stranger = await createUser()
    const admin = await createUser({ role: 'admin' })
    const [event] = await db.insert(events).values({ ownerId: owner.id, name: 'Festival' }).returning()

    await expect(join(url, event.id, tokenFor(stranger))).rejects.toThrow()

    await expect(join(url, event.id, tokenFor(admin, { verified: false }))).rejects.toThrow()

    const o = await join(url, event.id, tokenFor(owner))
    o.room.send('cross_world_update', { action: { presetId: 'x' } })
    expect((await o.waitFor('cross_world_dispatched')).eventId).toBe(event.id)

    const a = await join(url, event.id, tokenFor(admin))
    a.room.send('cross_world_update', { action: { presetId: 'y' } })
    expect((await a.waitFor('cross_world_dispatched')).action).toEqual({ presetId: 'y' })
  })

  it('rejects anonymous, invalid and scene-pass joins', async () => {
    const owner = await createUser()
    const [event] = await db.insert(events).values({ ownerId: owner.id, name: 'Festival' }).returning()
    const c = new Client(url)
    await expect(c.joinOrCreate('virvi_command_center', { eventId: event.id })).rejects.toThrow()
    await expect(c.joinOrCreate('virvi_command_center', { eventId: event.id, sessionToken: 'garbage' })).rejects.toThrow()
    const pass = tokenFor(owner, { kind: 'scene', sceneId: crypto.randomUUID() })
    await expect(join(url, event.id, pass)).rejects.toThrow()
  })

  it('different events land in different rooms; a stranger cannot join another owner\'s event', async () => {
    const a = await createUser()
    const b = await createUser()
    const [ea] = await db.insert(events).values({ ownerId: a.id, name: 'A' }).returning()
    const [eb] = await db.insert(events).values({ ownerId: b.id, name: 'B' }).returning()
    const ja = await join(url, ea.id, tokenFor(a))
    const jb = await join(url, eb.id, tokenFor(b))
    expect(ja.room.roomId).not.toBe(jb.room.roomId)
    await expect(join(url, eb.id, tokenFor(a))).rejects.toThrow()
  })

  it('fans out only to scenes the sender fully controls', async () => {
    const a = await createUser()
    const b = await createUser()
    const { scene: mine } = await createScene(a)
    const { scene: theirs } = await createScene(b)
    const [event] = await db.insert(events).values({ ownerId: a.id, name: 'Festival' }).returning()
    await db.insert(eventSceneLinks).values([{ eventId: event.id, sceneId: mine.id }, { eventId: event.id, sceneId: theirs.id }])
    const o = await join(url, event.id, tokenFor(a))
    o.room.send('cross_world_update', { action: { presetId: 'x' } })
    expect((await o.waitFor('cross_world_dispatched')).targetScenes).toEqual([mine.id])
  })
})
