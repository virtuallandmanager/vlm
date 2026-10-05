import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Wallet } from 'ethers'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { analyticsScenes, userAuthMethods, users, scenes } from '../src/db/schema.js'
import { setDclDirectory } from '../src/analytics/dcl-directory.js'
import { reverifyClaims } from '../src/analytics/claims.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor } from './helpers/factories.js'
import { createAnalyticsScene } from './helpers/analytics.js'
import { FakeDclDirectory } from './helpers/fake-dcl.js'

const rights = (o: Partial<{ owner: string; operator: string; updateOperator: string; updateManagers: string[]; approvedForAll: string[] }> = {}) => ({
  owner: null, operator: null, updateOperator: null, updateManagers: [], approvedForAll: [], ...o,
})

describe('wallet sign-in', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => {
    await resetDb()
    app = await testApp()
  })
  afterEach(() => app.close())

  async function signIn(wallet: Wallet, bearer?: string) {
    const ch = await app.inject({ method: 'POST', url: '/api/auth/wallet/challenge', payload: { address: wallet.address } })
    const { nonce, message } = ch.json()
    const signature = await wallet.signMessage(message)
    return app.inject({
      method: 'POST',
      url: '/api/auth/wallet/verify',
      payload: { address: wallet.address, nonce, signature },
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    })
  }

  it('signs in with a personal_sign signature and marks the wallet verified', async () => {
    const w = Wallet.createRandom()
    const res = await signIn(w)
    expect(res.statusCode).toBe(200)
    const m = await db.query.userAuthMethods.findFirst({ where: eq(userAuthMethods.identifier, w.address.toLowerCase()) })
    expect((m!.metadata as any).verified).toBe(true)
  })

  it('rejects a wrong signature and a reused nonce', async () => {
    const w = Wallet.createRandom()
    const other = Wallet.createRandom()
    const ch = await app.inject({ method: 'POST', url: '/api/auth/wallet/challenge', payload: { address: w.address } })
    const { nonce, message } = ch.json()
    const bad = await app.inject({ method: 'POST', url: '/api/auth/wallet/verify', payload: { address: w.address, nonce, signature: await other.signMessage(message) } })
    expect(bad.statusCode).toBe(401)
    const good = await app.inject({ method: 'POST', url: '/api/auth/wallet/verify', payload: { address: w.address, nonce, signature: await w.signMessage(message) } })
    expect(good.statusCode).toBe(401) // nonce consumed by the failed attempt
  })

  it('a legacy unverified wallet record is re-homed to a new user, not the squatter', async () => {
    const w = Wallet.createRandom()
    const squatter = await createUser()
    await db.insert(userAuthMethods).values({ userId: squatter.id, type: 'wallet', identifier: w.address.toLowerCase(), metadata: { verified: false } })
    const res = await signIn(w)
    expect(res.json().user.id).not.toBe(squatter.id)
    const m = await db.query.userAuthMethods.findFirst({ where: eq(userAuthMethods.identifier, w.address.toLowerCase()) })
    expect(m!.userId).toBe(res.json().user.id)
  })

  it('with a Bearer token, links the wallet to the signed-in email user', async () => {
    const u = await createUser()
    const w = Wallet.createRandom()
    const res = await signIn(w, tokenFor(u))
    expect(res.json()).toMatchObject({ linked: true })
    const m = await db.query.userAuthMethods.findFirst({ where: eq(userAuthMethods.identifier, w.address.toLowerCase()) })
    expect(m!.userId).toBe(u.id)
  })
})

describe('claims', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let dir: FakeDclDirectory
  beforeEach(async () => {
    await resetDb()
    dir = new FakeDclDirectory()
    setDclDirectory(dir)
    app = await testApp()
  })
  afterEach(async () => {
    setDclDirectory(null)
    await app.close()
  })

  const W = '0x00000000000000000000000000000000000000c1'
  const claim = (u: any, locationKey: string) =>
    app.inject({ method: 'POST', url: '/api/analytics/claims', payload: { locationKey }, headers: { authorization: `Bearer ${tokenFor(u)}` } })

  it.each([
    ['owner', { owner: W }],
    ['operator', { operator: W }],
    ['updateOperator', { updateOperator: W }],
    ['updateManager', { updateManagers: [W] }],
    ['approvedForAll', { approvedForAll: [W] }],
  ])('Genesis City: %s of every parcel can claim; a VLM scene is created and linked', async (_l, r) => {
    const u = await createUser({ wallet: W })
    const s = await createAnalyticsScene({ locationKey: 'gc:1,1', parcels: ['1,1', '1,2'], title: 'Arbor' })
    dir.rights.set('1,1', rights(r))
    dir.rights.set('1,2', rights(r))
    const res = await claim(u, 'gc:1,1')
    expect(res.statusCode).toBe(200)
    const row = await db.query.analyticsScenes.findFirst({ where: eq(analyticsScenes.id, s.id) })
    expect(row).toMatchObject({ claimedByUserId: u.id, claimStatus: 'active' })
    const vlm = await db.query.scenes.findFirst({ where: eq(scenes.id, row!.vlmSceneId!) })
    expect(vlm).toMatchObject({ ownerId: u.id, name: 'Arbor' })
  })

  it('controlling only some parcels is not enough; deployer of the active scene on every parcel is', async () => {
    const u = await createUser({ wallet: W })
    await createAnalyticsScene({ locationKey: 'gc:1,1', parcels: ['1,1', '1,2'] })
    dir.rights.set('1,1', rights({ owner: W }))
    dir.rights.set('1,2', rights({ owner: '0x0000000000000000000000000000000000000999' }))
    expect((await claim(u, 'gc:1,1')).statusCode).toBe(403)
    dir.deployers.set('1,1', W)
    dir.deployers.set('1,2', W)
    expect((await claim(u, 'gc:1,1')).statusCode).toBe(200)
  })

  it('worlds: only the name owner can claim', async () => {
    const u = await createUser({ wallet: W })
    await createAnalyticsScene({ kind: 'world', locationKey: 'world:foo.dcl.eth', worldName: 'foo.dcl.eth', baseParcel: null, parcels: [] })
    dir.worldOwners.set('foo.dcl.eth', '0x0000000000000000000000000000000000000999')
    expect((await claim(u, 'world:foo.dcl.eth')).statusCode).toBe(403)
    dir.worldOwners.set('foo.dcl.eth', W)
    expect((await claim(u, 'world:foo.dcl.eth')).statusCode).toBe(200)
  })

  it('users without a verified wallet get 403; unknown locations 404; directory down 503 (never a false "not owner")', async () => {
    const emailOnly = await createUser()
    await createAnalyticsScene({ locationKey: 'gc:1,1', parcels: ['1,1'] })
    expect((await claim(emailOnly, 'gc:1,1')).statusCode).toBe(403)
    const u = await createUser({ wallet: W })
    expect((await claim(u, 'gc:9,9')).statusCode).toBe(404)
    dir.down = true
    expect((await claim(u, 'gc:1,1')).statusCode).toBe(503)
  })

  it('an active claim by someone else blocks a new claim (409)', async () => {
    const holder = await createUser()
    const u = await createUser({ wallet: W })
    await createAnalyticsScene({ locationKey: 'gc:1,1', parcels: ['1,1'], claimedByUserId: holder.id, claimStatus: 'active' })
    dir.rights.set('1,1', rights({ owner: W }))
    expect((await claim(u, 'gc:1,1')).statusCode).toBe(409)
  })

  it('check endpoint reports eligibility for in-world setup', async () => {
    const u = await createUser({ wallet: W })
    await createAnalyticsScene({ locationKey: 'gc:1,1', parcels: ['1,1'] })
    dir.rights.set('1,1', rights({ owner: W }))
    const res = await app.inject({ method: 'GET', url: '/api/analytics/claims/check?locationKey=gc:1,1', headers: { authorization: `Bearer ${tokenFor(u)}` } })
    expect(res.json()).toEqual({ eligible: true, claimed: false, mine: false })
  })

  it('daily re-verification lapses claims the wallet no longer controls', async () => {
    const u = await createUser({ wallet: W })
    const s = await createAnalyticsScene({ locationKey: 'gc:1,1', parcels: ['1,1'], claimedByUserId: u.id, claimStatus: 'active' })
    dir.rights.set('1,1', rights({ owner: '0x0000000000000000000000000000000000000999' }))
    expect(await reverifyClaims()).toEqual({ checked: 1, lapsed: 1 })
    const row = await db.query.analyticsScenes.findFirst({ where: eq(analyticsScenes.id, s.id) })
    expect(row).toMatchObject({ claimStatus: 'lapsed' })
    expect(row!.lapsedAt).not.toBeNull()
  })

  it('re-verification leaves claims alone when the directory is down', async () => {
    const u = await createUser({ wallet: W })
    await createAnalyticsScene({ locationKey: 'gc:1,1', parcels: ['1,1'], claimedByUserId: u.id, claimStatus: 'active' })
    dir.down = true
    expect(await reverifyClaims()).toEqual({ checked: 1, lapsed: 0 })
  })
})
