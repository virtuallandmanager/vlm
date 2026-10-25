import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { sceneDeployments, sceneRoles } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, tokenFor, type TestUser } from './helpers/factories.js'

const PUBLIC_TARGET = { parcels: ['0,0'], contentServer: 'https://1.1.1.1' }

describe('deploy routes authorization', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let a: TestUser, b: TestUser, cohost: TestUser
  let aScene: string, bScene: string
  let bDcl: string, bHyperfy: string

  const call = (user: TestUser, method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${tokenFor(user)}` }, payload: payload as any })

  beforeEach(async () => {
    await resetDb()
    app = await testApp()
    a = await createUser()
    b = await createUser()
    cohost = await createUser()
    aScene = (await createScene(a, 'A')).scene.id
    bScene = (await createScene(b, 'B')).scene.id
    await db.insert(sceneRoles).values({ sceneId: bScene, userId: cohost.id, walletAddress: '0xc0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0', role: 'cohost' } as any)
    bDcl = (await db.insert(sceneDeployments).values({ sceneId: bScene, platform: 'decentraland', deploymentType: 'parcel', target: PUBLIC_TARGET, deployedBy: b.id }).returning())[0].id
    bHyperfy = (await db.insert(sceneDeployments).values({
      sceneId: bScene, platform: 'hyperfy', deploymentType: 'instance', status: 'deployed',
      target: { instanceUrl: 'https://h.example', adminCode: 'sekret' }, deployedBy: b.id,
    }).returning())[0].id
  })
  afterEach(async () => { await app.close() })

  const rows = () => db.select().from(sceneDeployments)

  it('every deployment route answers 404 to a stranger', async () => {
    const calls: Array<[string, string, unknown?]> = [
      ['GET', `/api/deploy/${bDcl}`],
      ['GET', `/api/deploy/scene/${bScene}`],
      ['POST', `/api/deploy/${bDcl}/cancel`],
    ]
    for (const [m, url, payload] of calls) {
      const res = await call(a, m as 'GET' | 'POST', url, payload)
      expect(res.statusCode, `${m} ${url}`).toBe(404)
    }
    expect(await rows()).toHaveLength(2)
    expect((await db.query.sceneDeployments.findFirst({ where: eq(sceneDeployments.id, bDcl) }))!.status).toBe('pending')
  })

  it('owner and cohost can read and cancel', async () => {
    for (const user of [b, cohost]) {
      expect((await call(user, 'GET', `/api/deploy/${bDcl}`)).statusCode).toBe(200)
      expect((await call(user, 'GET', `/api/deploy/scene/${bScene}`)).json().deployments).toHaveLength(2)
    }
    expect((await call(cohost, 'POST', `/api/deploy/${bDcl}/cancel`)).statusCode).toBe(200)
  })

  it('admin keeps access', async () => {
    const admin = await createUser({ role: 'admin' })
    expect((await call(admin, 'GET', `/api/deploy/${bDcl}`)).statusCode).toBe(200)
  })

  it('never returns adminCode', async () => {
    const one = await call(b, 'GET', `/api/deploy/${bHyperfy}`)
    expect(one.statusCode).toBe(200)
    expect(one.json().deployment.target.instanceUrl).toBe('https://h.example')
    expect(one.body).not.toContain('adminCode')
    expect(one.body).not.toContain('sekret')
    const list = await call(b, 'GET', `/api/deploy/scene/${bScene}`)
    expect(list.body).not.toContain('sekret')
  })
})
