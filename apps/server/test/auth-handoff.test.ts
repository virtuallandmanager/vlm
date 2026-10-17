import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { authHandoffCodes } from '../src/db/schema.js'
import { runDailyJobs } from '../src/analytics/jobs.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor, createScene } from './helpers/factories.js'
import { verifySessionToken } from '../src/auth/tokens.js'

const WALLET = '0x00000000000000000000000000000000000000aa'
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

describe('in-world sign-in hand-off', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => {
    await resetDb()
    app = await testApp()
  })
  afterEach(() => app.close())

  const createCode = (token?: string) =>
    app.inject({ method: 'POST', url: '/api/auth/handoff', headers: token ? { authorization: `Bearer ${token}` } : {} })
  const exchange = (payload: unknown) => app.inject({ method: 'POST', url: '/api/auth/handoff/exchange', payload: payload as object })

  it('a verified wallet token gets a single-use code that exchanges for a session of the same user', async () => {
    const user = await createUser({ wallet: WALLET, email: null })
    const before = Date.now()
    const res = await createCode(tokenFor(user))
    expect(res.statusCode).toBe(200)
    const { code, expiresAt } = res.json()
    expect(typeof code).toBe('string')
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const exp = new Date(expiresAt).getTime()
    expect(exp).toBeGreaterThanOrEqual(before + 59_000)
    expect(exp).toBeLessThanOrEqual(Date.now() + 61_000)

    const rows = await db.select().from(authHandoffCodes)
    expect(rows).toHaveLength(1)
    expect(rows[0].codeHash).toBe(sha256(code))
    expect(rows[0].userId).toBe(user.id)
    expect(rows[0].wallet).toBe(WALLET)
    expect(rows[0].usedAt).toBeNull()
    expect(JSON.stringify(rows[0])).not.toContain(code)

    const ok = await exchange({ code })
    expect(ok.statusCode).toBe(200)
    const body = ok.json()
    expect(body.user).toMatchObject({ id: user.id, role: user.role })
    const claims = app.jwt.verify<Record<string, unknown>>(body.accessToken)
    expect(claims).toMatchObject({ id: user.id, wallet: WALLET, verified: true })
    expect(claims.kind).toBe('account')
    expect(claims.refresh).toBeUndefined()
    const refresh = app.jwt.verify<Record<string, unknown>>(body.refreshToken)
    expect(refresh).toMatchObject({ id: user.id, wallet: WALLET, verified: true, refresh: true })

    const [used] = await db.select().from(authHandoffCodes).where(eq(authHandoffCodes.codeHash, sha256(code)))
    expect(used.usedAt).not.toBeNull()

    const again = await exchange({ code })
    expect(again.statusCode).toBe(410)
    expect(again.json()).toEqual({ error: 'This sign-in link has expired' })
  })

  it('unverified, guest and refresh tokens are refused', async () => {
    const user = await createUser({ wallet: WALLET })
    const unverified = await createCode(tokenFor(user, { verified: false }))
    expect(unverified.statusCode).toBe(401)
    expect(unverified.json()).toEqual({ error: 'Sign-in hand-off needs a verified wallet' })

    const noWallet = await createCode(tokenFor({ ...user, wallet: null }))
    expect(noWallet.statusCode).toBe(401)
    expect(noWallet.json()).toEqual({ error: 'Sign-in hand-off needs a verified wallet' })

    expect((await createCode(tokenFor(user, { guest: true }))).statusCode).toBe(401)
    expect((await createCode(tokenFor(user, { refresh: true }))).statusCode).toBe(401)
    expect((await createCode()).statusCode).toBe(401)
    expect(await db.select().from(authHandoffCodes)).toHaveLength(0)
  })

  it('expired and unknown codes are refused', async () => {
    const user = await createUser({ wallet: WALLET })
    const expired = randomBytes(32).toString('base64url')
    await db.insert(authHandoffCodes).values({ codeHash: sha256(expired), userId: user.id, wallet: WALLET, expiresAt: new Date(Date.now() - 1000) })
    const gone = await exchange({ code: expired })
    expect(gone.statusCode).toBe(410)
    expect(gone.json()).toEqual({ error: 'This sign-in link has expired' })
    const [row] = await db.select().from(authHandoffCodes)
    expect(row.usedAt).toBeNull()

    for (const payload of [{ code: randomBytes(32).toString('base64url') }, {}, { code: 42 }, { code: ['x'] }, { code: '' }, { code: 'a'.repeat(5000) }]) {
      const res = await exchange(payload)
      expect(res.statusCode, JSON.stringify(payload).slice(0, 40)).toBe(410)
      expect(res.json()).toEqual({ error: 'This sign-in link has expired' })
    }
  })

  it('limits code creation per user', async () => {
    const user = await createUser({ wallet: WALLET })
    const other = await createUser({ wallet: '0x00000000000000000000000000000000000000bb' })
    for (let i = 0; i < 5; i++) expect((await createCode(tokenFor(user))).statusCode).toBe(200)
    const limited = await createCode(tokenFor(user))
    expect(limited.statusCode).toBe(429)
    expect(limited.json()).toMatchObject({ error: 'rate_limited', retryAfter: expect.any(Number) })
    expect((await createCode(tokenFor(other))).statusCode).toBe(200)
  })

  it('limits exchange attempts per IP', async () => {
    for (let i = 0; i < 20; i++) expect((await exchange({ code: 'nope' })).statusCode).toBe(410)
    const limited = await exchange({ code: 'nope' })
    expect(limited.statusCode).toBe(429)
    expect(limited.json()).toMatchObject({ error: 'rate_limited', retryAfter: expect.any(Number) })
  })

  it("creating a code clears the user's expired codes, and the daily purge drops day-old rows", async () => {
    const user = await createUser({ wallet: WALLET })
    const other = await createUser({ wallet: '0x00000000000000000000000000000000000000bb' })
    const old = new Date(Date.now() - 1000)
    await db.insert(authHandoffCodes).values([
      { codeHash: sha256('mine-expired'), userId: user.id, wallet: WALLET, expiresAt: old },
      { codeHash: sha256('theirs-expired'), userId: other.id, wallet: other.wallet!, expiresAt: old },
    ])
    expect((await createCode(tokenFor(user))).statusCode).toBe(200)
    const hashes = (await db.select().from(authHandoffCodes)).map((r) => r.codeHash)
    expect(hashes).not.toContain(sha256('mine-expired'))
    expect(hashes).toContain(sha256('theirs-expired'))

    await db.insert(authHandoffCodes).values({ codeHash: sha256('ancient'), userId: other.id, wallet: other.wallet!, expiresAt: new Date(Date.now() - 2 * 86_400_000) })
    await db.execute(sql`delete from analytics_job_runs`)
    await runDailyJobs(new Date())
    const left = (await db.select().from(authHandoffCodes)).map((r) => r.codeHash)
    expect(left).not.toContain(sha256('ancient'))
    expect(left).toContain(sha256('theirs-expired'))
    expect(left).toHaveLength(2)
  })

  it('a code minted with a scene pass exchanges for the same scene pass, never an account session', async () => {
    const u = await createUser({ wallet: '0x00000000000000000000000000000000000000c1' })
    const { scene } = await createScene(u)
    const t = tokenFor(u, { kind: 'scene', sceneId: scene.id, locationId: null, orgId: null })
    const { code } = (await app.inject({ method: 'POST', url: '/api/auth/handoff', headers: { authorization: `Bearer ${t}` } })).json()
    const ex = await app.inject({ method: 'POST', url: '/api/auth/handoff/exchange', payload: { code } })
    expect(ex.statusCode).toBe(200)
    expect(verifySessionToken(ex.json().accessToken)).toMatchObject({ kind: 'scene', sceneId: scene.id })
    expect(ex.json().scene).toEqual({ sceneId: scene.id, locationId: null })
  })

  it('a visitor pass cannot mint a hand-off code', async () => {
    const u = await createUser({ wallet: '0x00000000000000000000000000000000000000c2' })
    const t = tokenFor(u, { kind: 'scene', sceneId: null, orgId: null })
    const res = await app.inject({ method: 'POST', url: '/api/auth/handoff', headers: { authorization: `Bearer ${t}` } })
    expect(res.statusCode).toBe(403)
  })
})
