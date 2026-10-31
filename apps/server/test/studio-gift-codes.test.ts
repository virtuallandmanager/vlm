import { describe, it, expect, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { studioGiftCodes, studioGiftRedemptions, studioFinalizeCredits, studioPromptCredits, studioPayments } from '../src/db/schema.js'
import { newGiftCode, normalizeGiftCode, hashGiftCode } from '../src/studio/gift-codes.js'
import { resetDb } from './helpers/db.js'
import { createUser } from './helpers/factories.js'

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
