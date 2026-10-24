import { createHash, timingSafeEqual } from 'node:crypto'

/** Hex SHA-256: how pairing codes and device secrets are stored. */
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

/** Constant-time comparison of two hashes. */
export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}
