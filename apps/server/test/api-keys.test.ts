import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { db } from '../src/db/connection.js'
import { apiKeys, organizations, orgMembers } from '../src/db/schema.js'
import { getSceneAccess } from '../src/auth/permissions.js'
import { actorFromClaims } from '../src/auth/actor.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, tokenFor } from './helpers/factories.js'

describe('api keys', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(async () => { await app.close() })

  const create = (headers: Record<string, string>, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/keys', headers, payload })

  it('a key cannot mint keys; a session can, and responses carry no scopes', async () => {
    const u = await createUser()
    const res = await create({ authorization: `Bearer ${tokenFor(u)}` }, { name: 'k', scopes: ['scenes:read'] })
    expect(res.statusCode).toBe(201)
    expect(res.json()).not.toHaveProperty('scopes')
    const [row] = await db.select().from(apiKeys)
    expect(row.scopes).toBeNull()
    expect((await app.inject({ method: 'GET', url: '/api/keys', headers: { authorization: `Bearer ${tokenFor(u)}` } })).json().keys[0]).not.toHaveProperty('scopes')

    const viaKey = await create({ authorization: `Bearer ${res.json().key}` }, { name: 'child' })
    expect(viaKey.statusCode).toBe(403)
  })

  it('new keys start virvi_k1_, and an old vlm_k1_ key is refused', async () => { // virvi-rename: keep
    const u = await createUser()
    const res = await create({ authorization: `Bearer ${tokenFor(u)}` }, { name: 'k' })
    expect(res.json().key).toMatch(/^virvi_k1_[0-9a-f]{32}$/)
    const old = `vlm_k1_${'0'.repeat(32)}` // virvi-rename: keep
    expect((await app.inject({ method: 'GET', url: '/api/keys', headers: { authorization: `Bearer ${old}` } })).statusCode).toBe(401)
  })

  it('orgId must be an org the caller belongs to', async () => {
    const u = await createUser()
    const other = await createUser()
    const [mine] = await db.insert(organizations).values({ name: 'Mine', slug: 'mine' }).returning()
    const [theirs] = await db.insert(organizations).values({ name: 'Theirs', slug: 'theirs' }).returning()
    await db.insert(orgMembers).values([{ orgId: mine.id, userId: u.id, role: 'member' }, { orgId: theirs.id, userId: other.id, role: 'owner' }])
    const headers = { authorization: `Bearer ${tokenFor(u)}` }
    expect((await create(headers, { name: 'k', orgId: theirs.id })).statusCode).toBe(400)
    expect((await create(headers, { name: 'k', orgId: mine.id })).statusCode).toBe(201)
  })

  it('claim-less account tokens are unverified; an API key still acts as its owner', async () => {
    const u = await createUser()
    const { scene } = await createScene(u)
    expect((await getSceneAccess(actorFromClaims({ id: u.id, role: u.role, kind: 'account', verified: true }), scene.id)).level).not.toBe('none')
    const bare = await app.inject({ method: 'GET', url: '/api/scenes', headers: { authorization: `Bearer ${tokenFor(u, { verified: undefined })}` } })
    expect(bare.json().scenes).toEqual([])
    expect((await getSceneAccess(actorFromClaims({ id: u.id, role: u.role, kind: 'account' }), scene.id)).level).toBe('none')

    const rawKey = 'virvi_k1_' + 'a'.repeat(32)
    await db.insert(apiKeys).values({ userId: u.id, name: 'k', keyHash: createHash('sha256').update(rawKey).digest('hex'), keyPrefix: rawKey.slice(0, 8) })
    const viaKey = await app.inject({ method: 'GET', url: '/api/scenes', headers: { authorization: `Bearer ${rawKey}` } })
    expect(viaKey.json().scenes.map((s: any) => s.id)).toContain(scene.id)
  })
})
