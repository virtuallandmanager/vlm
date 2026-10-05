import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { users, userAuthMethods } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { verifySessionToken } from '../src/auth/tokens.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor } from './helpers/factories.js'

vi.mock('../src/middleware/dcl-auth.js', () => ({
  hasDclAuthHeaders: (h: Record<string, unknown>) => !!h['x-identity-auth-chain-0'],
  verifyDclSignedFetch: async (_m: string, _p: string, h: Record<string, string>) => {
    const v = h['x-identity-auth-chain-0']
    if (typeof v === 'string' && v.startsWith('valid:')) return { walletAddress: v.slice(6), metadata: {} }
    throw new Error('bad signature')
  },
}))

const WALLET = '0x00000000000000000000000000000000000000aa'
const VICTIM = '0x00000000000000000000000000000000000000bb'

describe('POST /api/auth/platform', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => {
    await resetDb()
    app = await testApp()
  })
  afterEach(async () => {
    ;(config as any).allowUnverifiedPlatformAuth = false
    await app.close()
  })

  it('verified signed fetch creates a wallet user and a verified token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/platform',
      headers: { 'x-identity-auth-chain-0': `valid:${WALLET}` },
      payload: { user: { displayName: 'Alice' } },
    })
    expect(res.statusCode).toBe(200)
    const claims = verifySessionToken(res.json().accessToken)!
    expect(claims.wallet).toBe(WALLET)
    expect(claims.verified).toBe(true)
    const method = await db.query.userAuthMethods.findFirst({ where: eq(userAuthMethods.identifier, WALLET) })
    expect(method).toBeTruthy()
  })

  it('a forged body wallet with a bad signature gets a guest token and no account', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/platform',
      headers: { 'x-identity-auth-chain-0': 'forged' },
      payload: { user: { walletAddress: VICTIM, id: VICTIM } },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.guest).toBe(true)
    const claims = verifySessionToken(body.accessToken)!
    expect(claims.guest).toBe(true)
    expect(claims.wallet ?? null).toBeNull()
    expect(await db.query.userAuthMethods.findFirst({ where: eq(userAuthMethods.identifier, VICTIM) })).toBeUndefined()
  })

  it('a body wallet with no signature headers also gets a guest token', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/platform', payload: { user: { walletAddress: VICTIM } } })
    expect(res.json().guest).toBe(true)
  })

  it('guest tokens are rejected by authenticated REST routes', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/platform', payload: {} })
    const scenesRes = await app.inject({
      method: 'GET',
      url: '/api/scenes',
      headers: { authorization: `Bearer ${res.json().accessToken}` },
    })
    expect(scenesRes.statusCode).toBe(401)
  })

  it('preview mode issues an unverified token tied to a preview: identifier', async () => {
    ;(config as any).allowUnverifiedPlatformAuth = true
    const res = await app.inject({ method: 'POST', url: '/api/auth/platform', payload: { user: { id: VICTIM } } })
    const claims = verifySessionToken(res.json().accessToken)!
    expect(claims.verified).toBe(false)
    expect(claims.wallet ?? null).toBeNull()
    expect(await db.query.userAuthMethods.findFirst({ where: eq(userAuthMethods.identifier, `preview:${VICTIM}`) })).toBeTruthy()
    expect(await db.query.userAuthMethods.findFirst({ where: eq(userAuthMethods.identifier, VICTIM) })).toBeUndefined()
  })

  it('only the very first user is auto-promoted to admin', async () => {
    await createUser({ role: 'admin' })
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/platform',
      headers: { 'x-identity-auth-chain-0': `valid:${WALLET}` },
      payload: {},
    })
    expect(res.json().user.role).toBe('creator')
  })

  it('the first-ever platform user becomes admin in single mode', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/platform',
      headers: { 'x-identity-auth-chain-0': `valid:${WALLET}` },
      payload: {},
    })
    expect(res.json().user.role).toBe('admin')
  })

  it('refresh keeps wallet and verified=false', async () => {
    ;(config as any).allowUnverifiedPlatformAuth = true
    const login = await app.inject({ method: 'POST', url: '/api/auth/platform', payload: { user: { id: 'p1' } } })
    const refreshed = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      headers: { authorization: `Bearer ${login.json().refreshToken}` },
    })
    expect(refreshed.statusCode).toBe(200)
    expect(verifySessionToken(refreshed.json().accessToken)!.verified).toBe(false)
  })

  it('refresh tokens are rejected as bearer access tokens but still refresh', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/platform',
      headers: { 'x-identity-auth-chain-0': `valid:${WALLET}` },
      payload: {},
    })
    const { refreshToken } = login.json()
    const scenesRes = await app.inject({ method: 'GET', url: '/api/scenes', headers: { authorization: `Bearer ${refreshToken}` } })
    expect(scenesRes.statusCode).toBe(401)
    const refreshed = await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { authorization: `Bearer ${refreshToken}` } })
    expect(refreshed.statusCode).toBe(200)
    const ok = await app.inject({ method: 'GET', url: '/api/scenes', headers: { authorization: `Bearer ${refreshed.json().accessToken}` } })
    expect(ok.statusCode).toBe(200)
  })

  it('verifySessionToken rejects refresh tokens and garbage', async () => {
    const u = await createUser()
    expect(verifySessionToken(tokenFor(u, { refresh: true }))).toBeNull()
    expect(verifySessionToken('not-a-jwt')).toBeNull()
    expect(verifySessionToken(undefined)).toBeNull()
  })
})
