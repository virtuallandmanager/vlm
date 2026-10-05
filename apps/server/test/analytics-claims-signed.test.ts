import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { count } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { users, userAuthMethods } from '../src/db/schema.js'
import { setSignedClaimLimiter } from '../src/routes/analytics-claims.js'
import { TokenBucketLimiter } from '../src/analytics/limiter.js'
import { createUser } from './helpers/factories.js'
import { setDclDirectory } from '../src/analytics/dcl-directory.js'
import { resetDb } from './helpers/db.js'
import { testApp } from './helpers/factories.js'
import { createAnalyticsScene } from './helpers/analytics.js'
import { FakeDclDirectory } from './helpers/fake-dcl.js'

vi.mock('../src/middleware/dcl-auth.js', () => ({
  hasDclAuthHeaders: (h: Record<string, unknown>) => !!h['x-identity-auth-chain-0'],
  verifyDclSignedFetch: async (_m: string, _p: string, h: Record<string, string>) => {
    const v = h['x-identity-auth-chain-0']
    if (typeof v === 'string' && v.startsWith('valid:')) return { walletAddress: v.slice(6), metadata: {} }
    throw new Error('bad signature')
  },
}))

const W = '0x00000000000000000000000000000000000000aa'
const signed = (w = W) => ({ 'x-identity-auth-chain-0': `valid:${w}` })
const rights = (o: Record<string, unknown> = {}) => ({
  owner: null, operator: null, updateOperator: null, updateManagers: [], approvedForAll: [], ...o,
})

describe('POST /api/analytics/claims/check-signed', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let dir: FakeDclDirectory
  beforeEach(async () => {
    await resetDb()
    app = await testApp()
    dir = new FakeDclDirectory()
    setDclDirectory(dir)
    setSignedClaimLimiter(new TokenBucketLimiter())
  })
  afterEach(async () => {
    setDclDirectory(null)
    await app.close()
  })
  const post = (locationKey: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: '/api/analytics/claims/check-signed', payload: { locationKey }, headers })
  const counts = async () => [
    (await db.select({ n: count() }).from(users))[0].n,
    (await db.select({ n: count() }).from(userAuthMethods))[0].n,
  ]

  it('a controller is eligible and no users or auth methods are created', async () => {
    await createAnalyticsScene({ locationKey: 'gc:1,1', parcels: ['1,1'] })
    dir.rights.set('1,1', rights({ owner: W }))
    const before = await counts()
    const res = await post('gc:1,1', signed())
    expect(res.json()).toEqual({ eligible: true, known: true })
    expect(await counts()).toEqual(before)
  })

  it('unsigned or badly signed requests are not eligible', async () => {
    await createAnalyticsScene({ locationKey: 'gc:1,1', parcels: ['1,1'] })
    dir.rights.set('1,1', rights({ owner: W }))
    expect((await post('gc:1,1')).json()).toEqual({ eligible: false, known: false })
    expect((await post('gc:1,1', { 'x-identity-auth-chain-0': 'garbage' })).json()).toEqual({ eligible: false, known: false })
  })

  it('an unknown location reports known false', async () => {
    expect((await post('gc:9,9', signed())).json()).toEqual({ eligible: false, known: false })
  })

  it('a non-controller is not eligible', async () => {
    await createAnalyticsScene({ locationKey: 'gc:1,1', parcels: ['1,1'] })
    dir.rights.set('1,1', rights({ owner: '0x00000000000000000000000000000000000000bb' }))
    expect((await post('gc:1,1', signed())).json()).toEqual({ eligible: false, known: true })
  })

  it('an active claim is eligible for the claimer\'s verified wallet only, and creates no rows', async () => {
    const u = await createUser()
    await db.insert(userAuthMethods).values({ userId: u.id, type: 'wallet', identifier: W, metadata: { verified: true } } as any)
    await createAnalyticsScene({ locationKey: 'gc:1,1', parcels: ['1,1'], claimedByUserId: u.id, claimStatus: 'active' })
    const other = '0x00000000000000000000000000000000000000bb'
    dir.rights.set('1,1', rights({ owner: other }))
    const before = await counts()
    expect((await post('gc:1,1', signed())).json()).toEqual({ eligible: true, known: true })
    expect((await post('gc:1,1', signed(other))).json()).toEqual({ eligible: false, known: true })
    expect(await counts()).toEqual(before)
  })

  it('a burst from one IP with different wallets gets 429', async () => {
    const codes: number[] = []
    for (let i = 0; i < 6; i++) {
      const w = '0x' + (i + 1).toString(16).padStart(40, '0')
      codes.push((await post('gc:9,9', signed(w))).statusCode)
    }
    expect(codes).toContain(429)
    expect(codes[0]).toBe(200)
  })
})
