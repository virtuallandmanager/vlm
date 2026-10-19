import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { db } from '../src/db/connection.js'
import { assetLibraryItems, catalogPacks } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor } from './helpers/factories.js'

const pack = (id: string, enabled = true) => ({ id, name: `Pack ${id}`, source: 'dhingia', license: 'mit', attribution: 'Copyright (c) 2022 Mr Dhingia', sourceUrl: 'https://github.com/MrDhingia/DhingiaBuilds', enabled })
const models = (packId: string, count: number) =>
  db.insert(assetLibraryItems).values(Array.from({ length: count }, (_, i) => ({ name: `${packId} ${i}`, storageKey: `k/${packId}/${i}`, packId, sourceRef: `${i}`, isPublic: true })))

describe('catalog pack routes', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => {
    await resetDb()
    app = await testApp()
    await db.insert(catalogPacks).values([pack('a'), pack('b', false), pack('empty')])
    await models('a', 2)
    await models('b', 1)
  })
  afterEach(async () => { await app.close() })

  const as = async (role: 'admin' | 'creator') => ({ authorization: `Bearer ${tokenFor(await createUser({ role }))}` })

  it('admin lists packs with counts', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/catalog/packs', headers: await as('admin') })
    expect(res.statusCode).toBe(200)
    const byId = Object.fromEntries(res.json().packs.map((p: any) => [p.id, p]))
    expect(byId.a).toMatchObject({ name: 'Pack a', enabled: true, modelCount: 2, license: 'mit' })
    expect(byId.b).toMatchObject({ enabled: false, modelCount: 1 })
    expect(byId.empty.modelCount).toBe(0)
  })

  it('admin turns a pack off and on', async () => {
    const headers = await as('admin')
    const total = async () => (await app.inject({ method: 'GET', url: '/api/assets' })).json().total
    expect(await total()).toBe(2)
    const off = await app.inject({ method: 'PATCH', url: '/api/admin/catalog/packs/a', headers, payload: { enabled: false } })
    expect(off.statusCode).toBe(200)
    expect(off.json().pack).toMatchObject({ id: 'a', enabled: false, modelCount: 2 })
    expect(await total()).toBe(0)
    await app.inject({ method: 'PATCH', url: '/api/admin/catalog/packs/a', headers, payload: { enabled: true } })
    expect(await total()).toBe(2)
  })

  it('non-admins get 403 on both admin routes', async () => {
    const headers = await as('creator')
    expect((await app.inject({ method: 'GET', url: '/api/admin/catalog/packs', headers })).statusCode).toBe(403)
    expect((await app.inject({ method: 'PATCH', url: '/api/admin/catalog/packs/a', headers, payload: { enabled: false } })).statusCode).toBe(403)
  })

  it('PATCH validates enabled and the id', async () => {
    const headers = await as('admin')
    expect((await app.inject({ method: 'PATCH', url: '/api/admin/catalog/packs/a', headers, payload: { enabled: 'no' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'PATCH', url: '/api/admin/catalog/packs/nope', headers, payload: { enabled: false } })).statusCode).toBe(404)
  })

  it('public packs list includes disabled packs that have models, and leaves out empty ones', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/catalog/packs' })
    expect(res.statusCode).toBe(200)
    const ids = res.json().packs.map((p: any) => p.id).sort()
    expect(ids).toEqual(['a', 'b'])
    expect(res.json().packs.find((p: any) => p.id === 'a')).toMatchObject({ attribution: 'Copyright (c) 2022 Mr Dhingia', sourceUrl: 'https://github.com/MrDhingia/DhingiaBuilds' })
  })
})
