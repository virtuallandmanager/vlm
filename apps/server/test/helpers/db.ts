import { sql } from 'drizzle-orm'
import { db } from '../../src/db/connection.js'

export async function resetDb() {
  const rows = await db.execute<{ tablename: string }>(
    sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  )
  const names = (rows as unknown as { tablename: string }[]).map((r) => `"${r.tablename}"`)
  if (!names.length) return
  // A query left running by the previous test can lock tables in the opposite order: retry the deadlock
  for (let attempt = 1; ; attempt++) {
    try {
      await db.execute(sql.raw(`TRUNCATE ${names.join(', ')} RESTART IDENTITY CASCADE`))
      return
    } catch (err) {
      if ((err as { code?: string }).code !== '40P01' || attempt >= 5) throw err
      await new Promise((r) => setTimeout(r, 50 * attempt))
    }
  }
}
