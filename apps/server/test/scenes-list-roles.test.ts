import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { db } from '../src/db/connection.js'
import { sceneRoles } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, tokenFor, randomWallet } from './helpers/factories.js'

describe('GET /api/scenes with scene roles', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => {
    await resetDb()
    app = await testApp()
  })
  afterEach(() => app.close())

  it('lists scenes where the user has a role (by wallet or user id), once, with the role as relationship', async () => {
    const host = await createUser()
    const { scene: a } = await createScene(host, 'A')
    const { scene: b } = await createScene(host, 'B')
    const me = await createUser({ wallet: randomWallet() })
    await db.insert(sceneRoles).values([
      { sceneId: a.id, walletAddress: me.wallet!, role: 'cohost' },
      { sceneId: b.id, walletAddress: randomWallet(), userId: me.id, role: 'viewer' },
      { sceneId: b.id, walletAddress: me.wallet!, role: 'viewer', revokedAt: new Date() },
    ])
    const res = await app.inject({ method: 'GET', url: '/api/scenes', headers: { authorization: `Bearer ${tokenFor(me)}` } })
    const got = res.json().scenes.map((s: any) => [s.name, s.relationship]).sort()
    expect(got).toEqual([['A', 'cohost'], ['B', 'viewer']])
  })
})
