import { createHash, randomInt } from 'node:crypto'

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

/** Codes are stored hashed; only the last four characters are kept as a hint. */
export function hashGiftCode(raw: string): string {
  return createHash('sha256').update(normalizeGiftCode(raw)).digest('hex')
}
