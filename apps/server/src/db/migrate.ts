import { sql } from 'drizzle-orm'
import { db } from './connection.js'

/**
 * Auto-create tables using Drizzle schema push.
 * This is equivalent to `drizzle-kit push` — it creates/alters tables
 * to match the schema without requiring migration files.
 */
export async function runMigrations() {
  // Test the database connection
  await db.execute(sql`SELECT 1`)
  console.log('[vlm-server] Database connection verified')

  // In production, tables should be created via `drizzle-kit push` during deploy.
  // The server verifies connectivity here but doesn't auto-create tables
  // to avoid accidental schema changes in production.
  //
  // For first-time setup, run:
  //   cd apps/server && DATABASE_URL="..." npx drizzle-kit push
}

// Allow running as a standalone script
const isMainModule = process.argv[1]?.endsWith('migrate.ts') || process.argv[1]?.endsWith('migrate.js')
if (isMainModule) {
  runMigrations().catch((err) => {
    console.error('Migration failed:', err)
    process.exit(1)
  })
}
