import { and, eq } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { userAuthMethods, users } from '../db/schema.js'
import { initialRoleForNewUser } from './roles.js'

const isVerified = (m: { metadata: unknown }) => (m.metadata as { verified?: unknown } | null)?.verified === true

async function findWalletMethod(wallet: string) {
  return db.query.userAuthMethods.findFirst({
    where: and(eq(userAuthMethods.type, 'wallet'), eq(userAuthMethods.identifier, wallet.toLowerCase())),
    with: { user: true },
  })
}

/** The user that owns this proven wallet, created on first sight. */
export async function resolveVerifiedWalletUser(wallet: string, displayName: string) {
  const w = wallet.toLowerCase()
  const existing = await findWalletMethod(w)
  if (existing && isVerified(existing)) return existing.user
  const [user] = await db.insert(users).values({ displayName, email: null, role: await initialRoleForNewUser() }).returning()
  await db.insert(userAuthMethods).values({ userId: user.id, type: 'wallet', identifier: w, metadata: { verified: true } })
  return user
}

/** Attach a proven wallet to an existing (e.g. email) user. */
export async function linkVerifiedWallet(userId: string, wallet: string): Promise<'linked' | 'already' | 'conflict'> {
  const w = wallet.toLowerCase()
  const existing = await findWalletMethod(w)
  if (existing && existing.userId === userId && isVerified(existing)) return 'already'
  if (existing && isVerified(existing) && existing.userId !== userId) return 'conflict'
  await db.insert(userAuthMethods).values({ userId, type: 'wallet', identifier: w, metadata: { verified: true } })
  return 'linked'
}
