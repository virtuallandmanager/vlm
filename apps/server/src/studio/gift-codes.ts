import { createHash, randomInt } from 'node:crypto'
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { studioFinalizeCredits, studioGiftCodes, studioGiftRedemptions, studioPromptCredits, users } from '../db/schema.js'

// Read-aloud alphabet: no 0/O, 1/I/L, so a code survives being said over a call
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'

/** A new code as shown once to the admin: three groups of four, e.g. 'K7QM-2XPA-9RTD'. */
export function newGiftCode(): string {
  const group = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')
  return `${group()}-${group()}-${group()}`
}

/** What a user typed, reduced to the code's characters: uppercase, no spaces or hyphens. */
export function normalizeGiftCode(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]/g, '')
}

/** Codes are stored hashed (see giftCodeHint for the one part kept in the clear). */
export function hashGiftCode(raw: string): string {
  return createHash('sha256').update(normalizeGiftCode(raw)).digest('hex')
}

/** The last four characters of the normalized code: all an admin sees of it after creation. */
export function giftCodeHint(raw: string): string {
  return normalizeGiftCode(raw).slice(-4)
}

export class GiftCodeError extends Error {
  constructor(public status: number, public code: string) {
    super(code)
  }
}

export interface GiftCodeInput {
  prompts: number
  finalizes: number
  maxUses: number
  expiresAt: Date | null
  note: string | null
}

const inRange = (n: number, min: number, max: number) => Number.isInteger(n) && n >= min && n <= max

/** Makes a code. The plain code is returned once and never stored. */
export async function createGiftCode(by: string, input: GiftCodeInput, now: Date): Promise<{ code: string; id: string }> {
  const { prompts, finalizes, maxUses, expiresAt, note } = input
  if (
    !inRange(prompts, 0, 1000) || !inRange(finalizes, 0, 20) || (prompts === 0 && finalizes === 0) || !inRange(maxUses, 1, 1000) ||
    (expiresAt !== null && !(expiresAt.getTime() > now.getTime())) || (note !== null && note.length > 200)
  ) throw new GiftCodeError(400, 'invalid')
  const code = newGiftCode()
  const [row] = await db.insert(studioGiftCodes).values({
    codeHash: hashGiftCode(code), codeHint: giftCodeHint(code), note, prompts, finalizes, maxUses, expiresAt, createdBy: by, createdAt: now,
  }).returning({ id: studioGiftCodes.id })
  return { code, id: row.id }
}

/** Every code, newest first, with who redeemed it (oldest first). */
export async function listGiftCodes() {
  const codes = await db.select().from(studioGiftCodes).orderBy(desc(studioGiftCodes.createdAt))
  const redemptions = await db
    .select({ codeId: studioGiftRedemptions.codeId, email: users.email, name: users.displayName, at: studioGiftRedemptions.createdAt })
    .from(studioGiftRedemptions)
    .leftJoin(users, eq(users.id, studioGiftRedemptions.userId))
    .orderBy(asc(studioGiftRedemptions.createdAt))
  return codes.map((c) => ({
    id: c.id, hint: c.codeHint, note: c.note, prompts: c.prompts, finalizes: c.finalizes, maxUses: c.maxUses, uses: c.uses,
    expiresAt: c.expiresAt, disabledAt: c.disabledAt, createdAt: c.createdAt,
    redemptions: redemptions.filter((r) => r.codeId === c.id).map(({ email, name, at }) => ({ email, name, at })),
  }))
}

/** Turns a code off (already-off stays as it was). False when there is no such code. */
export async function disableGiftCode(id: string, now: Date): Promise<boolean> {
  const rows = await db.update(studioGiftCodes)
    .set({ disabledAt: sql`coalesce(${studioGiftCodes.disabledAt}, ${now.toISOString()}::timestamptz)` })
    .where(eq(studioGiftCodes.id, id))
    .returning({ id: studioGiftCodes.id })
  return rows.length > 0
}

/**
 * Redeems a code for a user: gifted prompts and free first-finalizes. The code row is locked for the whole
 * transaction, so the last use goes to one redeemer; the unique (code, user) index backs the one-per-account rule.
 */
export async function redeemGiftCode(userId: string, raw: string, now: Date): Promise<{ prompts: number; finalizes: number }> {
  try {
    return await db.transaction(async (tx) => {
      const [code] = await tx.select().from(studioGiftCodes).where(eq(studioGiftCodes.codeHash, hashGiftCode(raw))).for('update')
      if (!code) throw new GiftCodeError(404, 'unknown_code')
      if (code.disabledAt) throw new GiftCodeError(410, 'code_off')
      if (code.expiresAt && code.expiresAt.getTime() <= now.getTime()) throw new GiftCodeError(410, 'code_expired')
      if (code.uses >= code.maxUses) throw new GiftCodeError(410, 'code_used_up')
      const [had] = await tx.select({ id: studioGiftRedemptions.id }).from(studioGiftRedemptions)
        .where(and(eq(studioGiftRedemptions.codeId, code.id), eq(studioGiftRedemptions.userId, userId)))
      if (had) throw new GiftCodeError(409, 'already_redeemed')
      await tx.insert(studioGiftRedemptions).values({ codeId: code.id, userId, createdAt: now })
      await tx.update(studioGiftCodes).set({ uses: sql`${studioGiftCodes.uses} + 1` }).where(eq(studioGiftCodes.id, code.id))
      await tx.insert(studioPromptCredits).values({ userId, balance: 0, gifted: code.prompts, updatedAt: now })
        .onConflictDoUpdate({ target: studioPromptCredits.userId, set: { gifted: sql`${studioPromptCredits.gifted} + ${code.prompts}`, updatedAt: now } })
      await tx.insert(studioFinalizeCredits).values({ userId, balance: code.finalizes, updatedAt: now })
        .onConflictDoUpdate({ target: studioFinalizeCredits.userId, set: { balance: sql`${studioFinalizeCredits.balance} + ${code.finalizes}`, updatedAt: now } })
      return { prompts: code.prompts, finalizes: code.finalizes }
    })
  } catch (err) {
    if ((err as { code?: string }).code === '23505' || (err as { cause?: { code?: string } }).cause?.code === '23505') {
      throw new GiftCodeError(409, 'already_redeemed')
    }
    throw err
  }
}
