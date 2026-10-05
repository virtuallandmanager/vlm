import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Wallet } from 'ethers'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { userAuthMethods } from '../src/db/schema.js'
import { controls } from '../src/analytics/claims.js'
import { resetDb } from './helpers/db.js'
import { config } from '../src/config.js'
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

  it('rejects unverified and refresh Bearer tokens without linking the wallet', async () => {
    const u = await createUser()
    const w = Wallet.createRandom()
    const r1 = await signIn(w, tokenFor(u, { verified: false }))
    expect(r1.statusCode).toBe(401)
    const w2 = Wallet.createRandom()
    const r2 = await signIn(w2, tokenFor(u, { refresh: true }))
    expect(r2.statusCode).toBe(401)
    for (const x of [w, w2]) {
      expect(await db.query.userAuthMethods.findFirst({ where: eq(userAuthMethods.identifier, x.address.toLowerCase()) })).toBeUndefined()
    }
  })

  it('issues an EIP-4361 message that still verifies', async () => {
    const w = Wallet.createRandom()
    const ch = await app.inject({ method: 'POST', url: '/api/auth/wallet/challenge', payload: { address: w.address } })
    const { message } = ch.json()
    expect(message).toContain(new URL(config.publicUrl).host)
    expect(message).toContain('URI: ')
    expect(message).toContain('Chain ID: 1')
    expect(message).toContain(w.address)
    expect((await signIn(w)).statusCode).toBe(200)
  })

  it('a malformed WEB_APP_URL still produces a challenge', async () => {
    const prev = config.webAppUrl
    ;(config as any).webAppUrl = 'not a url'
    try {
      const w = Wallet.createRandom()
      const ch = await app.inject({ method: 'POST', url: '/api/auth/wallet/challenge', payload: { address: w.address } })
      expect(ch.statusCode).toBe(200)
      expect(ch.json().message).toContain(new URL(config.publicUrl).host)
    } finally {
      ;(config as any).webAppUrl = prev
    }
  })
})

// `controls` (still used by in-world setup and check-signed) decides who controls a location.
describe('location control', () => {
  let dir: FakeDclDirectory
  beforeEach(async () => {
    await resetDb()
    dir = new FakeDclDirectory()
  })

  const W = '0x00000000000000000000000000000000000000c1'

  it.each([
    ['owner', { owner: W }],
    ['operator', { operator: W }],
    ['updateOperator', { updateOperator: W }],
    ['updateManager', { updateManagers: [W] }],
    ['approvedForAll', { approvedForAll: [W] }],
  ])('Genesis City: %s of every parcel controls the location', async (_l, r) => {
    const s = await createAnalyticsScene({ locationKey: 'gc:1,1', parcels: ['1,1', '1,2'] })
    dir.rights.set('1,1', rights(r))
    dir.rights.set('1,2', rights(r))
    expect(await controls(s, W, dir)).toBe(true)
  })

  it('controlling only some parcels is not enough; deployer of the active scene on every parcel is', async () => {
    const s = await createAnalyticsScene({ locationKey: 'gc:1,1', parcels: ['1,1', '1,2'] })
    dir.rights.set('1,1', rights({ owner: W }))
    dir.rights.set('1,2', rights({ owner: '0x0000000000000000000000000000000000000999' }))
    expect(await controls(s, W, dir)).toBe(false)
    dir.deployers.set('1,1', W)
    dir.deployers.set('1,2', W)
    expect(await controls(s, W, dir)).toBe(true)
  })

  it('worlds: the name owner controls the world', async () => {
    const s = await createAnalyticsScene({ kind: 'world', locationKey: 'world:foo.dcl.eth', worldName: 'foo.dcl.eth', baseParcel: null, parcels: [] })
    dir.worldOwners.set('foo.dcl.eth', '0x0000000000000000000000000000000000000999')
    expect(await controls(s, W, dir)).toBe(false)
    dir.worldOwners.set('foo.dcl.eth', W)
    expect(await controls(s, W, dir)).toBe(true)
  })
})
