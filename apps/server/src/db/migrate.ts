import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

export async function runMigrations() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL required')
  const sql = postgres(url, { max: 1 })
  const db = drizzle(sql)
  await migrate(db, { migrationsFolder: './drizzle' })
  await sql.end()
  console.log('[vlm-server] Migrations complete')
}

// Allow running as a standalone script
const isMainModule = process.argv[1]?.endsWith('migrate.ts') || process.argv[1]?.endsWith('migrate.js')
if (isMainModule) {
  runMigrations().catch((err) => {
    console.error('Migration failed:', err)
    process.exit(1)
  })
}
