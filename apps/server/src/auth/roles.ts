import { db } from '../db/connection.js'
import { config } from '../config.js'

/** Admin only for the very first user in single/scalable mode; everyone else is a creator. */
export async function initialRoleForNewUser(): Promise<'admin' | 'creator'> {
  if (!config.autoPromoteFirstUser) return 'creator'
  const anyUser = await db.query.users.findFirst({ columns: { id: true } })
  return anyUser ? 'creator' : 'admin'
}
