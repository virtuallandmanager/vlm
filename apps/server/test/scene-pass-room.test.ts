import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Client } from 'colyseus.js'
import { resetDb } from './helpers/db.js'
import { createUser, createScene, createElement, tokenFor } from './helpers/factories.js'
import { db } from '../src/db/connection.js'
import { arDevices, hyperfyPairings, hyperfyWorlds } from '../src/db/schema.js'
import { revokePairing } from '../src/hyperfy/pairing.js'
import { endDeviceSession, revokeDevice } from '../src/ar/devices.js'
import { sha256 } from '../src/auth/hash.js'
import { eq } from 'drizzle-orm'
import { startGameServer, joinScene, serverRoom } from './helpers/game-server.js'

const actorsIn = (roomId: string) => serverRoom(roomId).clients.map((c: any) => c.auth)
const screenUpdate = (id: string) => ({ action: 'update', element: 'video', elementData: { sk: id, liveSrc: 'https://x/live.m3u8' } })

/** An already-joined session loses edit access once its pairing or headset is revoked (no re-join, no renew). */
async function editsStopAfterRevoke(url: string, scene: { id: string; activePresetId: string | null }, pass: string, revoke: () => Promise<unknown>) {
  const screen = await createElement(scene.activePresetId!)
  const c = await joinScene(url, scene.id, pass)
  await c.waitFor('scene_preset_update') // init
  c.room.send('scene_preset_update', screenUpdate(screen.id))
  await c.waitFor('scene_preset_update_ack')
  await revoke()
  c.room.send('scene_preset_update', screenUpdate(screen.id))
  expect((await c.waitFor('vlm_error')).code).toBe('forbidden')
  c.room.leave()
}

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

  describe('pass expiry', () => {
    const update = (id: string) => ({ action: 'update', element: 'video', elementData: { sk: id, liveSrc: 'https://x/live.m3u8' } })
    async function joined() {
      const owner = await createUser()
      const { scene, preset } = await createScene(owner, 'A')
      const screen = await createElement(preset.id)
      const pass = () => tokenFor(owner, { kind: 'scene', sceneId: scene.id, orgId: null })
      const c = await joinScene(gs.url, scene.id, pass())
      await c.waitFor('scene_preset_update') // init
      const srv = serverRoom(c.room.roomId)
      const sessionId = c.room.sessionId
      const expire = () => { srv.passExpiry.set(sessionId, Date.now() - 1); srv.accessCache.clear() }
      return { owner, scene, screen, c, pass, expire }
    }

    it('after the pass expires the connection acts as an anonymous visitor', async () => {
      const { screen, c, expire } = await joined()
      c.room.send('scene_preset_update', update(screen.id))
      await c.waitFor('scene_preset_update_ack')
      expire()
      c.room.send('scene_preset_update', update(screen.id))
      expect((await c.waitFor('vlm_error')).code).toBe('forbidden')
      c.room.leave()
    })

    it('auth_renew with a fresh pass for the same user and scene restores access', async () => {
      const { screen, c, pass, expire } = await joined()
      expire()
      c.room.send('auth_renew', { sessionToken: pass() })
      await c.waitFor('auth_renew_ack')
      c.room.send('scene_preset_update', update(screen.id))
      await c.waitFor('scene_preset_update_ack')
      c.room.leave()
    })

    it('auth_renew refuses another user, another scene, a visitor pass or an account token', async () => {
      const { owner, scene, c, expire } = await joined()
      expire()
      const other = await createUser()
      const b = await createScene(owner, 'B')
      for (const sessionToken of [
        tokenFor(other, { kind: 'scene', sceneId: scene.id, orgId: null }),
        tokenFor(owner, { kind: 'scene', sceneId: b.scene.id, orgId: null }),
        tokenFor(owner, { kind: 'scene', sceneId: null, orgId: null }),
        tokenFor(owner),
        'garbage',
      ]) {
        c.room.send('auth_renew', { sessionToken })
        expect((await c.waitFor('vlm_error')).code).toBe('auth_renew_refused')
      }
      c.room.leave()
    })
  })

  describe('Hyperfy passes', () => {
    async function hyperfyJoin() {
      const owner = await createUser()
      const { scene } = await createScene(owner, 'H')
      const [world] = await db.insert(hyperfyWorlds).values({ sceneId: scene.id, ownerId: owner.id, name: 'W', keyHash: crypto.randomUUID(), keyPrefix: 'vlmw_x' }).returning()
      const [p] = await db.insert(hyperfyPairings).values({ worldId: world.id, userId: owner.id, secretHash: 'h', status: 'claimed', codeExpiresAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000) }).returning()
      const pass = (pairingId: string | undefined = p.id) => tokenFor(owner, { kind: 'scene', sceneId: scene.id, orgId: null, via: 'hyperfy', pairingId, worldId: world.id })
      return { owner, scene, p, pass }
    }

    it('a live Hyperfy pass joins as its user; a revoked one joins as anonymous', async () => {
      const { owner, scene, p, pass } = await hyperfyJoin()
      const live = await joinScene(gs.url, scene.id, pass())
      expect(actorsIn(live.room.roomId).at(-1).userId).toBe(owner.id)
      live.room.leave()
      expect(await revokePairing(p.id, owner.id)).toBe(true)
      const revoked = await joinScene(gs.url, scene.id, pass())
      expect(actorsIn(revoked.room.roomId).at(-1).userId).toBeNull()
      revoked.room.leave()
      const noId = await joinScene(gs.url, scene.id, pass(null as any))
      expect(actorsIn(noId.room.roomId).at(-1).userId).toBeNull()
      noId.room.leave()
    })

    it('a joined session stops editing once its Hyperfy pairing is revoked', async () => {
      const { owner, scene, p, pass } = await hyperfyJoin()
      await editsStopAfterRevoke(gs.url, scene, pass(), () => revokePairing(p.id, owner.id))
    })

    it('auth_renew refuses a revoked Hyperfy pass', async () => {
      const { owner, scene, p, pass } = await hyperfyJoin()
      const c = await joinScene(gs.url, scene.id, pass())
      c.room.send('auth_renew', { sessionToken: pass() })
      await c.waitFor('auth_renew_ack')
      await revokePairing(p.id, owner.id)
      c.room.send('auth_renew', { sessionToken: pass() })
      expect((await c.waitFor('vlm_error')).code).toBe('auth_renew_refused')
      c.room.send('auth_renew', { sessionToken: pass(null as any) })
      expect((await c.waitFor('vlm_error')).code).toBe('auth_renew_refused')
      c.room.leave()
    })
  })

  describe('AR passes', () => {
    async function arJoin() {
      const owner = await createUser()
      const { scene } = await createScene(owner, 'AR')
      const [d] = await db.insert(arDevices).values({ userId: owner.id, secretHash: 'h', kind: 'personal', status: 'claimed', codeExpiresAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000) }).returning()
      const pass = (deviceId: string | undefined = d.id) => tokenFor(owner, { kind: 'scene', sceneId: scene.id, orgId: null, via: 'ar', deviceId })
      return { owner, scene, d, pass }
    }

    it('a live AR pass joins as its user; a revoked one joins as anonymous', async () => {
      const { owner, scene, d, pass } = await arJoin()
      const live = await joinScene(gs.url, scene.id, pass())
      expect(actorsIn(live.room.roomId).at(-1).userId).toBe(owner.id)
      live.room.leave()
      expect(await revokeDevice(d.id, owner.id)).toBe(true)
      const revoked = await joinScene(gs.url, scene.id, pass())
      expect(actorsIn(revoked.room.roomId).at(-1).userId).toBeNull()
      revoked.room.leave()
      const noId = await joinScene(gs.url, scene.id, pass(null as any))
      expect(actorsIn(noId.room.roomId).at(-1).userId).toBeNull()
      noId.room.leave()
    })

    it('a joined session stops editing once its headset is revoked', async () => {
      const { owner, scene, d, pass } = await arJoin()
      await editsStopAfterRevoke(gs.url, scene, pass(), () => revokeDevice(d.id, owner.id))
    })

    it('a joined session stops editing once its shared headset session ends', async () => {
      const { scene, d, pass } = await arJoin()
      await db.update(arDevices).set({ kind: 'shared', secretHash: sha256('s') }).where(eq(arDevices.id, d.id))
      await editsStopAfterRevoke(gs.url, scene, pass(), () => endDeviceSession(d.id, 's'))
    })

    it('auth_renew refuses a revoked AR pass', async () => {
      const { owner, scene, d, pass } = await arJoin()
      const c = await joinScene(gs.url, scene.id, pass())
      c.room.send('auth_renew', { sessionToken: pass() })
      await c.waitFor('auth_renew_ack')
      await revokeDevice(d.id, owner.id)
      c.room.send('auth_renew', { sessionToken: pass() })
      expect((await c.waitFor('vlm_error')).code).toBe('auth_renew_refused')
      c.room.leave()
    })
  })
})
