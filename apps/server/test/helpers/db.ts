import { sql } from 'drizzle-orm'
import { db } from '../../src/db/connection.js'

export async function resetDb() {
  const rows = await db.execute<{ tablename: string }>(
    sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  )
  const names = (rows as unknown as { tablename: string }[]).map((r) => `"${r.tablename}"`)
  if (names.length) await db.execute(sql.raw(`TRUNCATE ${names.join(', ')} RESTART IDENTITY CASCADE`))
}
