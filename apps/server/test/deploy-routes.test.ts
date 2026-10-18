import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { sceneDeployments, deploymentWallets, sceneRoles } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, tokenFor, type TestUser } from './helpers/factories.js'

// Routes must never reach the catalyst; the real deployer is exercised directly below.
const deployMock = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('../src/services/dcl/deployer.js', async () => {
  const actual = await vi.importActual<typeof import('../src/services/dcl/deployer.js')>('../src/services/dcl/deployer.js')
  return { ...actual, executeDCLDeploy: deployMock }
})

const PUBLIC_TARGET = { parcels: ['0,0'], contentServer: 'https://1.1.1.1' }

describe('deploy routes authorization', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let a: TestUser, b: TestUser, cohost: TestUser
  let aScene: string, bScene: string
  let bWallet: string, aWallet: string
  let bDcl: string, bHyperfy: string

  const call = (user: TestUser, method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${tokenFor(user)}` }, payload: payload as any })

  beforeEach(async () => {
    await resetDb()
    deployMock.mockClear()
    app = await testApp()
    a = await createUser()
    b = await createUser()
    cohost = await createUser()
    aScene = (await createScene(a, 'A')).scene.id
    bScene = (await createScene(b, 'B')).scene.id
    await db.insert(sceneRoles).values({ sceneId: bScene, userId: cohost.id, walletAddress: '0xc0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0', role: 'cohost' } as any)
    bWallet = (await db.insert(deploymentWallets).values({ userId: b.id, platform: 'decentraland', walletAddress: '0xb', encryptedPrivateKey: 'not-decryptable' }).returning())[0].id
    aWallet = (await db.insert(deploymentWallets).values({ userId: a.id, platform: 'decentraland', walletAddress: '0xa', encryptedPrivateKey: 'not-decryptable' }).returning())[0].id
    bDcl = (await db.insert(sceneDeployments).values({ sceneId: bScene, platform: 'decentraland', deploymentType: 'parcel', target: PUBLIC_TARGET, deployedBy: b.id }).returning())[0].id
    bHyperfy = (await db.insert(sceneDeployments).values({
      sceneId: bScene, platform: 'hyperfy', deploymentType: 'instance', status: 'deployed',
      target: { instanceUrl: 'https://h.example', adminCode: 'sekret' }, deployedBy: b.id,
    }).returning())[0].id
  })
  afterEach(async () => { await app.close() })

  const rows = () => db.select().from(sceneDeployments)

  it("POST /api/deploy refuses another user's walletId with 404 and creates no row", async () => {
    const before = (await rows()).length
    const res = await call(a, 'POST', '/api/deploy', { sceneId: aScene, platform: 'decentraland', deploymentType: 'parcel', target: PUBLIC_TARGET, walletId: bWallet })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'Wallet not found' })
    expect(await rows()).toHaveLength(before)
    expect(deployMock).not.toHaveBeenCalled()
  })

  it('POST /api/deploy accepts the caller own wallet; cohost can deploy to the host scene', async () => {
    const own = await call(a, 'POST', '/api/deploy', { sceneId: aScene, platform: 'decentraland', deploymentType: 'parcel', target: PUBLIC_TARGET, walletId: aWallet })
    expect(own.statusCode).toBe(201)
    expect(deployMock).toHaveBeenCalledWith(own.json().deployment.id, aWallet)
    const co = await call(cohost, 'POST', '/api/deploy', { sceneId: bScene, platform: 'decentraland', deploymentType: 'parcel', target: PUBLIC_TARGET })
    expect(co.statusCode).toBe(201)
  })

  it("POST /api/deploy on someone else's scene is refused", async () => {
    const res = await call(a, 'POST', '/api/deploy', { sceneId: bScene, platform: 'decentraland', deploymentType: 'parcel', target: PUBLIC_TARGET })
    expect([403, 404]).toContain(res.statusCode)
  })

  it('POST /api/deploy refuses private or non-https content servers', async () => {
    for (const contentServer of ['http://127.0.0.1:1', 'https://127.0.0.1', 'http://1.1.1.1', 'ftp://1.1.1.1']) {
      const res = await call(a, 'POST', '/api/deploy', { sceneId: aScene, platform: 'decentraland', deploymentType: 'parcel', target: { parcels: ['0,0'], contentServer } })
      expect(res.statusCode, contentServer).toBe(400)
      expect(res.json()).toEqual({ error: 'invalid_content_server' })
    }
    expect(await rows()).toHaveLength(2)
  })

  it('every deployment route answers 404 to a stranger', async () => {
    const calls: Array<[string, string, unknown?]> = [
      ['GET', `/api/deploy/${bDcl}`],
      ['GET', `/api/deploy/scene/${bScene}`],
      ['POST', `/api/deploy/${bDcl}/cancel`],
      ['POST', `/api/deploy/${bDcl}/redeploy`],
      ['POST', `/api/deploy/hyperfy/${bHyperfy}/destroy`],
      ['GET', `/api/deploy/hyperfy/${bHyperfy}/status`],
      ['GET', `/api/deploy/hyperfy/${bHyperfy}/logs`],
      ['POST', '/api/deploy/hyperfy/provision', { sceneId: bScene, name: 'x' }],
    ]
    for (const [m, url, payload] of calls) {
      const res = await call(a, m as 'GET' | 'POST', url, payload)
      expect(res.statusCode, `${m} ${url}`).toBe(404)
    }
    expect(await rows()).toHaveLength(2)
    expect((await db.query.sceneDeployments.findFirst({ where: eq(sceneDeployments.id, bDcl) }))!.status).toBe('pending')
  })

  it('redeploy never returns the hyperfy adminCode', async () => {
    await db.update(sceneDeployments).set({ target: { ...PUBLIC_TARGET, adminCode: 'secret-code' } }).where(eq(sceneDeployments.id, bDcl))
    const res = await call(b, 'POST', `/api/deploy/${bDcl}/redeploy`)
    expect(res.statusCode).toBe(201)
    expect(JSON.stringify(res.json())).not.toContain('secret-code')
    expect(res.json().deployment.target.adminCode).toBeUndefined()
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

describe('executeDCLDeploy wallet ownership', () => {
  beforeEach(async () => { await resetDb() })

  it('refuses a wallet owned by someone other than the deployer without decrypting', async () => {
    const { executeDCLDeploy } = await vi.importActual<typeof import('../src/services/dcl/deployer.js')>('../src/services/dcl/deployer.js')
    const a = await createUser(); const b = await createUser()
    const { scene } = await createScene(a)
    const w = (await db.insert(deploymentWallets).values({ userId: b.id, platform: 'decentraland', walletAddress: '0xb', encryptedPrivateKey: 'not-decryptable' }).returning())[0]
    const dep = (await db.insert(sceneDeployments).values({ sceneId: scene.id, platform: 'decentraland', deploymentType: 'parcel', target: PUBLIC_TARGET, deployedBy: a.id }).returning())[0]
    // 'not-decryptable' would make decryptPrivateKey throw, so a clean resolve means it was never called.
    await expect(executeDCLDeploy(dep.id, w.id)).resolves.toBeUndefined()
    const after = await db.query.sceneDeployments.findFirst({ where: eq(sceneDeployments.id, dep.id) })
    expect(after!.status).toBe('failed')
    expect(after!.errorMessage).toBe('Deployment wallet not found or has no private key')
  })
})
