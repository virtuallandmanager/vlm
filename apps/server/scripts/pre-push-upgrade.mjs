// Idempotent schema clean-up that must run before `drizzle-kit push`.
//
// The pre-analytics schema had `analytics_actions` and an `analytics_sessions` table keyed by
// `user_id`. Pushing the new schema over them makes drizzle-kit ask interactively whether
// tables/columns were "created or renamed", which `yes` cannot answer, so boot hangs. Those
// legacy tables never held data, so drop them first and let push create the new ones.
import postgres from 'postgres'

const url = process.env.DATABASE_URL
if (!url) {
  console.log('[vlm-server] pre-push upgrade: DATABASE_URL not set, skipping')
  process.exit(0)
}

const sql = postgres(url, { max: 1, onnotice: () => {} })
try {
  await sql`DROP TABLE IF EXISTS analytics_actions CASCADE`
  await sql`DO $$ BEGIN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'analytics_sessions' AND column_name = 'user_id'
    ) THEN
      DROP TABLE analytics_sessions CASCADE;
    END IF;
  END $$`
  console.log('[vlm-server] pre-push upgrade: legacy analytics tables cleared')
} finally {
  await sql.end()
}
