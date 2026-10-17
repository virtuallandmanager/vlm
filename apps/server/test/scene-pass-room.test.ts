import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Client } from 'colyseus.js'
import { resetDb } from './helpers/db.js'
import { createUser, createScene, tokenFor } from './helpers/factories.js'
import { startGameServer, joinScene, serverRoom } from './helpers/game-server.js'

const actorsIn = (roomId: string) => serverRoom(roomId).clients.map((c: any) => c.auth)

describe('scene pass in rooms', () => {
  let gs: Awaited<ReturnType<typeof startGameServer>>
  beforeAll(async () => { gs = await startGameServer() })
  afterAll(async () => { await gs.stop() })
  beforeEach(async () => { await resetDb() })

  it('a pass for its own scene keeps the user identity', async () => {
    const owner = await createUser()
    const a = await createScene(owner, 'A')
    const c = await joinScene(gs.url, a.scene.id, tokenFor(owner, { kind: 'scene', sceneId: a.scene.id, orgId: null }))
    expect(actorsIn(c.room.roomId).at(-1).userId).toBe(owner.id)
    c.room.leave()
  })

  it('a pass for another scene, or a visitor pass, joins as anonymous', async () => {
    const owner = await createUser()
    const a = await createScene(owner, 'A')
    const b = await createScene(owner, 'B')
    for (const sceneId of [a.scene.id, null]) {
      const c = await joinScene(gs.url, b.scene.id, tokenFor(owner, { kind: 'scene', sceneId, orgId: null }))
      expect(actorsIn(c.room.roomId).at(-1).userId).toBeNull()
      c.room.leave()
    }
  })

  it('claiming options.sceneId = A when joining scene B\'s room by id is still anonymous', async () => {
    const owner = await createUser()
    const a = await createScene(owner, 'A')
    const b = await createScene(owner, 'B')
    const first = await joinScene(gs.url, b.scene.id)
    const token = tokenFor(owner, { kind: 'scene', sceneId: a.scene.id, orgId: null })
    const room = await new Client(gs.url).joinById(first.room.roomId, { sceneId: a.scene.id, sessionToken: token, clientType: 'analytics' })
    expect(actorsIn(first.room.roomId).at(-1).userId).toBeNull()
    room.leave(); first.room.leave()
  })
})
