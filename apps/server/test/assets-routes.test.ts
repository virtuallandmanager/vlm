import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { assetLibraryItems } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor } from './helpers/factories.js'

describe('asset library routes', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  const prevUnlocked = config.allFeaturesUnlocked
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(async () => { config.allFeaturesUnlocked = prevUnlocked; await app.close() })

  const post = (user: Awaited<ReturnType<typeof createUser>>, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/assets', headers: { authorization: `Bearer ${tokenFor(user)}` }, payload: { name: 'Duck', filename: 'duck.glb', contentType: 'model/gltf-binary', fileData: 'AAAA', ...payload } })

  it('stores under a server-chosen key, ignoring path segments in the filename', async () => {
    const u = await createUser()
    const res = await post(u, { filename: '../../evil.glb' })
    expect(res.statusCode).toBe(201)
    const { asset } = res.json()
    expect(asset.storageKey).toMatch(new RegExp(`^assets/${u.id}/[0-9a-f-]{36}\\.glb$`))
    expect(asset.storageKey).not.toContain('..')
    expect(asset.isPublic).toBe(false)
  })

  it('refuses html and non-model uploads', async () => {
    const u = await createUser()
    const html = await post(u, { filename: 'a.html', contentType: 'text/html' })
    expect(html.statusCode).toBe(415)
    expect(html.json().error).toBe('unsupported_type')
    const png = await post(u, { filename: 'a.png', contentType: 'image/png' })
    expect(png.statusCode).toBe(415)
  })

  it('counts media and library bytes against the quota', async () => {
    config.allFeaturesUnlocked = false
    const u = await createUser()
    await db.insert(assetLibraryItems).values({ name: 'Big', storageKey: 'big', fileSizeBytes: 600 * 1024 * 1024, uploadedBy: u.id, isPublic: false })
    const res = await post(u, {})
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toBe('storage_limit_reached')
  })

  it('GET /api/assets/:id hides private assets from anonymous callers and other users', async () => {
    const owner = await createUser(); const other = await createUser(); const admin = await createUser({ role: 'admin' })
    const [priv] = await db.insert(assetLibraryItems).values({ name: 'P', storageKey: 'p', uploadedBy: owner.id, isPublic: false }).returning()
    const [pub] = await db.insert(assetLibraryItems).values({ name: 'Q', storageKey: 'q', uploadedBy: owner.id, isPublic: true }).returning()
    const get = (id: string, user?: Awaited<ReturnType<typeof createUser>>) =>
      app.inject({ method: 'GET', url: `/api/assets/${id}`, headers: user ? { authorization: `Bearer ${tokenFor(user)}` } : {} })
    expect((await get(priv.id)).statusCode).toBe(404)
    expect((await get(priv.id, other)).statusCode).toBe(404)
    expect((await get(priv.id, owner)).statusCode).toBe(200)
    expect((await get(priv.id, admin)).statusCode).toBe(200)
    expect((await get(pub.id)).statusCode).toBe(200)
    void eq
  })
})
