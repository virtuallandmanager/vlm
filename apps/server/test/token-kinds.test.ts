import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createSigner } from 'fast-jwt'
import { createHash } from 'node:crypto'
import { db } from '../src/db/connection.js'
import { apiKeys } from '../src/db/schema.js'
import { verifySessionToken } from '../src/auth/tokens.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor } from './helpers/factories.js'

const sign = createSigner({ key: 'test-secret', expiresIn: 15 * 60 * 1000 })

describe('token kinds', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(async () => { await app.close() })

  it('refuses a kind-less access token on REST with the session-expired message', async () => {
    const u = await createUser()
    const legacy = sign({ id: u.id, email: u.email, role: u.role, orgId: null, wallet: null, verified: true })
    const res = await app.inject({ method: 'GET', url: '/api/scenes', headers: { authorization: `Bearer ${legacy}` } })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'Unauthorized', message: 'Session expired — sign in again' })
  })

  it('verifySessionToken rejects kind-less tokens and accepts account tokens', async () => {
    const u = await createUser()
    expect(verifySessionToken(sign({ id: u.id, role: 'user' }))).toBeNull()
    expect(verifySessionToken(tokenFor(u))?.kind).toBe('account')
  })

  it('email login and refresh carry kind account; a kind-less refresh token is refused', async () => {
    await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'k@x.io', password: 'password123', displayName: 'K' } })
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'k@x.io', password: 'password123' } })
    const { accessToken, refreshToken } = login.json()
    expect(verifySessionToken(accessToken)?.kind).toBe('account')
    const r = await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { authorization: `Bearer ${refreshToken}` } })
    expect(verifySessionToken(r.json().accessToken)?.kind).toBe('account')
    const u = await createUser()
    const legacyRefresh = sign({ id: u.id, role: 'user', refresh: true })
    const r2 = await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { authorization: `Bearer ${legacyRefresh}` } })
    expect(r2.statusCode).toBe(401)
  })

  it('API keys still authenticate (they have no kind)', async () => {
    const u = await createUser()
    const key = 'virvi_' + 'a'.repeat(40)
    await db.insert(apiKeys).values({ userId: u.id, name: 't', keyHash: createHash('sha256').update(key).digest('hex'), keyPrefix: key.slice(0, 8) } as any)
    const res = await app.inject({ method: 'GET', url: '/api/scenes', headers: { authorization: `Bearer ${key}` } })
    expect(res.statusCode).toBe(200)
  })
})
