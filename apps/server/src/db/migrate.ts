import { sql } from 'drizzle-orm'
import { db } from './connection.js'
import { ensureVenueConstraints } from './venue-constraints.js'

/**
 * Boot-time database checks. Verifies connectivity and idempotently ensures the
 * btree_gist extension and the bookings exclusion constraint (double-booking
 * protection) that drizzle-kit push cannot express. Failure to ensure the
 * constraint is logged loudly but does not abort boot. Tables themselves are
 * created by `drizzle-kit push` at deploy, not here.
 */
export async function runMigrations() {
  // Test the database connection
  await db.execute(sql`SELECT 1`)
  console.log('[vlm-server] Database connection verified')

  try {
    await ensureVenueConstraints((q) => db.execute(sql.raw(q)))
    console.log('[vlm-server] Venue constraints ensured')
  } catch (err) {
    // Don't rethrow: boot must behave as before when drizzle-kit push failed.
    console.error(
      `[vlm-server] Venue constraints could not be ensured — double-booking protection is OFF: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // In production, tables should be created via `drizzle-kit push` during deploy.
  // The server does not auto-create tables here, to avoid accidental schema
  // changes in production; it only verifies connectivity and ensures the venue
  // constraints above.
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
