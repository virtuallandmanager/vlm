import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import { Client } from 'colyseus.js'
import { db } from '../src/db/connection.js'
import { events } from '../src/db/schema.js'
import { VLMCommandCenterRoom } from '../src/ws/VLMCommandCenterRoom.js'
import { resetDb } from './helpers/db.js'
import { createUser, tokenFor } from './helpers/factories.js'

const _require = createRequire(import.meta.url)
const { Server, LocalPresence } = _require('colyseus') as any
const { WebSocketTransport } = _require('@colyseus/ws-transport') as any

async function join(url: string, eventId: string, token: string) {
  const room = await new Client(url).joinOrCreate('vlm_command_center', { eventId, sessionToken: token })
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

describe('VLMCommandCenterRoom cross_world_update', () => {
  let server: any
  let url: string
  beforeEach(async () => {
    await resetDb()
    server = new Server({ transport: new WebSocketTransport(), presence: new LocalPresence() })
    server.define('vlm_command_center', VLMCommandCenterRoom)
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

    const s = await join(url, event.id, tokenFor(stranger))
    s.room.send('cross_world_update', { action: { presetId: 'x' } })
    expect((await s.waitFor('vlm_error')).code).toBe('forbidden')

    const unverifiedAdmin = await join(url, event.id, tokenFor(admin, { verified: false }))
    unverifiedAdmin.room.send('cross_world_update', { action: { presetId: 'x' } })
    expect((await unverifiedAdmin.waitFor('vlm_error')).code).toBe('forbidden')

    const o = await join(url, event.id, tokenFor(owner))
    o.room.send('cross_world_update', { action: { presetId: 'x' } })
    expect((await o.waitFor('cross_world_dispatched')).eventId).toBe(event.id)

    const a = await join(url, event.id, tokenFor(admin))
    a.room.send('cross_world_update', { action: { presetId: 'y' } })
    expect((await a.waitFor('cross_world_dispatched')).action).toEqual({ presetId: 'y' })
  })
})
