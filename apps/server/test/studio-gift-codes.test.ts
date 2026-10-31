import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { studioGiftCodes, studioGiftRedemptions, studioFinalizeCredits, studioPromptCredits, studioPayments } from '../src/db/schema.js'
import { newGiftCode, normalizeGiftCode, hashGiftCode, createGiftCode, redeemGiftCode } from '../src/studio/gift-codes.js'
import { buildApp } from '../src/app.js'
import { config } from '../src/config.js'
import { resetDb } from './helpers/db.js'
import { createUser, tokenFor } from './helpers/factories.js'

describe('gift code helpers', () => {
  it('makes 12-character codes from the read-aloud alphabet', () => {
    const c = newGiftCode()
    expect(c).toMatch(/^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/)
    expect(new Set(Array.from({ length: 50 }, newGiftCode)).size).toBe(50)
  })
  it('hashes the normalized code', () => {
    expect(hashGiftCode('abcd efgh-jkmn')).toBe(hashGiftCode('ABCD-EFGH-JKMN'))
    expect(hashGiftCode('ABCD-EFGH-JKMN')).toMatch(/^[0-9a-f]{64}$/)
    expect(normalizeGiftCode(' ab-cd ')).toBe('ABCD')
  })
})

describe('gift code schema', () => {
  beforeEach(resetDb)

  it('stores a code, a redemption and a finalize credit; a second redemption by the same user is a unique violation', async () => {
    const admin = await createUser()
    const user = await createUser()
    const code = newGiftCode()
    const [row] = await db.insert(studioGiftCodes).values({
      codeHash: hashGiftCode(code), codeHint: normalizeGiftCode(code).slice(-4), note: 'launch', prompts: 20, finalizes: 2, maxUses: 5, createdBy: admin.id,
    }).returning()
    expect(row.uses).toBe(0)
    expect(row.expiresAt).toBeNull()
    expect(row.disabledAt).toBeNull()
    await db.insert(studioGiftRedemptions).values({ codeId: row.id, userId: user.id })
    await db.insert(studioFinalizeCredits).values({ userId: user.id, balance: 2 })
    await db.insert(studioPromptCredits).values({ userId: user.id, balance: 0, gifted: 20 })
    const [pc] = await db.select().from(studioPromptCredits).where(eq(studioPromptCredits.userId, user.id))
    expect(pc.gifted).toBe(20)
    await expect(db.insert(studioGiftRedemptions).values({ codeId: row.id, userId: user.id })).rejects.toThrow()
    const [fc] = await db.select().from(studioFinalizeCredits).where(eq(studioFinalizeCredits.userId, user.id))
    expect(fc.balance).toBe(2)
  })

  it('studio_payments.gifts_held defaults to 0', async () => {
    const user = await createUser()
    const [p] = await db.insert(studioPayments).values({ userId: user.id, kind: 'topup', amountCents: 0 }).returning()
    expect(p.giftsHeld).toBe(0)
  })
})

describe('redeeming a gift code', () => {
  beforeEach(resetDb)
  const now = new Date()
  const make = async (over: Partial<Parameters<typeof createGiftCode>[1]> = {}) => {
    const admin = await createUser()
    return createGiftCode(admin.id, { prompts: 20, finalizes: 2, maxUses: 5, expiresAt: null, note: null, ...over }, now)
  }
  const refusal = (p: Promise<unknown>, status: number, code: string) => expect(p).rejects.toMatchObject({ status, code })

  it('redeems a code typed in lowercase with spaces', async () => {
    const { code } = await make()
    const user = await createUser()
    const got = await redeemGiftCode(user.id, ` ${code.toLowerCase().replace(/-/g, ' ')} `, now)
    expect(got).toEqual({ prompts: 20, finalizes: 2 })
    const [pc] = await db.select().from(studioPromptCredits).where(eq(studioPromptCredits.userId, user.id))
    const [fc] = await db.select().from(studioFinalizeCredits).where(eq(studioFinalizeCredits.userId, user.id))
    expect(pc.gifted).toBe(20)
    expect(fc.balance).toBe(2)
    const [row] = await db.select().from(studioGiftCodes)
    expect(row.uses).toBe(1)
  })

  it('adds to credits the user already has', async () => {
    const user = await createUser()
    await db.insert(studioPromptCredits).values({ userId: user.id, balance: 5, gifted: 3 })
    await db.insert(studioFinalizeCredits).values({ userId: user.id, balance: 1 })
    const { code } = await make()
    await redeemGiftCode(user.id, code, now)
    const [pc] = await db.select().from(studioPromptCredits).where(eq(studioPromptCredits.userId, user.id))
    const [fc] = await db.select().from(studioFinalizeCredits).where(eq(studioFinalizeCredits.userId, user.id))
    expect([pc.balance, pc.gifted, fc.balance]).toEqual([5, 23, 3])
  })

  it('refuses an unknown code', async () => {
    const user = await createUser()
    await refusal(redeemGiftCode(user.id, 'AAAA-BBBB-CCCC', now), 404, 'unknown_code')
  })
  it('refuses a code that is off', async () => {
    const { code, id } = await make()
    await db.update(studioGiftCodes).set({ disabledAt: now }).where(eq(studioGiftCodes.id, id))
    await refusal(redeemGiftCode((await createUser()).id, code, now), 410, 'code_off')
  })
  it('refuses an expired code', async () => {
    const { code, id } = await make()
    await db.update(studioGiftCodes).set({ expiresAt: new Date(now.getTime() - 1000) }).where(eq(studioGiftCodes.id, id))
    await refusal(redeemGiftCode((await createUser()).id, code, now), 410, 'code_expired')
    await db.update(studioGiftCodes).set({ expiresAt: now }).where(eq(studioGiftCodes.id, id))
    await refusal(redeemGiftCode((await createUser()).id, code, now), 410, 'code_expired')
  })
  it('refuses a used-up code', async () => {
    const { code } = await make({ maxUses: 1 })
    await redeemGiftCode((await createUser()).id, code, now)
    await refusal(redeemGiftCode((await createUser()).id, code, now), 410, 'code_used_up')
  })
  it('refuses a second redeem by the same account, and changes nothing', async () => {
    const { code } = await make()
    const user = await createUser()
    await redeemGiftCode(user.id, code, now)
    await refusal(redeemGiftCode(user.id, code, now), 409, 'already_redeemed')
    const [pc] = await db.select().from(studioPromptCredits).where(eq(studioPromptCredits.userId, user.id))
    expect(pc.gifted).toBe(20)
    expect((await db.select().from(studioGiftCodes))[0].uses).toBe(1)
  })
  it('refuses a second redeem by one account fired twice at once', async () => {
    const { code } = await make()
    const user = await createUser()
    const results = await Promise.allSettled([redeemGiftCode(user.id, code, now), redeemGiftCode(user.id, code, now)])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const bad = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(bad.reason).toMatchObject({ status: 409, code: 'already_redeemed' })
    expect((await db.select().from(studioGiftCodes))[0].uses).toBe(1)
  })

  it('the last use goes to one of two concurrent redeems', async () => {
    const { code } = await make({ maxUses: 1 })
    const [a, b] = [await createUser(), await createUser()]
    const results = await Promise.allSettled([redeemGiftCode(a.id, code, now), redeemGiftCode(b.id, code, now)])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const bad = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(bad.reason).toMatchObject({ code: 'code_used_up' })
    expect((await db.select().from(studioGiftCodes))[0].uses).toBe(1)
  })
})

describe('POST /api/studio/gift-codes/redeem', () => {
  let app: FastifyInstance
  const prev = config.studioEnabled
  beforeAll(async () => {
    ;(config as any).studioEnabled = true
    app = await buildApp({ logger: false, backfill: false })
    await app.ready()
  })
  afterAll(async () => {
    ;(config as any).studioEnabled = prev
    await app.close()
  })
  beforeEach(resetDb)

  const redeem = (token: string, code: string) => app.inject({
    method: 'POST', url: '/api/studio/gift-codes/redeem', headers: { authorization: `Bearer ${token}` }, payload: { code },
  })

  it('answers with what was given, and refusals with their code', async () => {
    const admin = await createUser()
    const { code } = await createGiftCode(admin.id, { prompts: 7, finalizes: 1, maxUses: 3, expiresAt: null, note: null }, new Date())
    const user = await createUser()
    const ok = await redeem(tokenFor(user), code)
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toEqual({ prompts: 7, finalizes: 1 })
    const again = await redeem(tokenFor(user), code)
    expect([again.statusCode, again.json()]).toEqual([409, { error: 'already_redeemed' }])
    const bad = await redeem(tokenFor(user), 'NOPE')
    expect([bad.statusCode, bad.json()]).toEqual([404, { error: 'unknown_code' }])
    expect((await app.inject({ method: 'POST', url: '/api/studio/gift-codes/redeem', payload: { code } })).statusCode).toBe(401)
    expect((await redeem(tokenFor(user), '')).statusCode).toBe(404)
    const notString = await app.inject({ method: 'POST', url: '/api/studio/gift-codes/redeem', headers: { authorization: `Bearer ${tokenFor(user)}` }, payload: { code: 5 } })
    expect(notString.statusCode).toBe(400)
  })

  it('limits one account to 10 attempts an hour; another account is unaffected', async () => {
    const [a, b] = [await createUser(), await createUser()]
    for (let i = 0; i < 10; i++) expect((await redeem(tokenFor(a), 'AAAA-BBBB-CCCC')).statusCode).toBe(404)
    expect((await redeem(tokenFor(a), 'AAAA-BBBB-CCCC')).statusCode).toBe(429)
    expect((await redeem(tokenFor(b), 'AAAA-BBBB-CCCC')).statusCode).toBe(404)
  })
})
