// Idempotent schema clean-up that must run before `drizzle-kit push`.
//
// The pre-analytics schema had `analytics_actions` and an `analytics_sessions` table keyed by
// `user_id`. Pushing the new schema over them makes drizzle-kit ask interactively whether
// tables/columns were "created or renamed", which `yes` cannot answer, so boot hangs. Those
// legacy tables never held data, so drop them first and let push create the new ones.
import { randomBytes } from 'node:crypto'
import postgres from 'postgres'

const url = process.env.DATABASE_URL
if (!url) {
  console.log('[virvi-server] pre-push upgrade: DATABASE_URL not set, skipping')
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
  // Key-value scene state was removed; drizzle push alone is unreliable at dropping it
  await sql`DROP TABLE IF EXISTS scene_state`
  // Per-user deploy wallets were replaced by World destinations. Push would ask whether
  // dcl_world_destinations was renamed from it; move it out of push's schema instead, keeping its rows.
  await sql`DO $$ BEGIN
    IF to_regclass('public.deployment_wallets') IS NOT NULL THEN
      CREATE SCHEMA IF NOT EXISTS retired;
      IF to_regclass('retired.deployment_wallets') IS NULL THEN
        ALTER TABLE public.deployment_wallets SET SCHEMA retired;
      END IF;
    END IF;
  END $$`
  // Add streaming_servers.playback_id ahead of push (plain nullable column; push then has nothing to ask)
  await sql`ALTER TABLE IF EXISTS streaming_servers ADD COLUMN IF NOT EXISTS playback_id text`
  // Streams provisioned before playback ids exposed the stream key in their public URL: give them an id and move the URL off the key
  const [{ present }] = await sql`SELECT to_regclass('streaming_servers') IS NOT NULL AS present`
  if (present) {
    const hlsBase = process.env.HLS_BASE_URL || 'http://localhost:8000/streams'
    const legacy = await sql`SELECT id FROM streaming_servers WHERE playback_id IS NULL`
    for (const { id } of legacy) {
      const playbackId = randomBytes(16).toString('hex')
      await sql`UPDATE streaming_servers SET playback_id = ${playbackId}, hls_playlist_url = ${`${hlsBase}/${playbackId}/playlist.m3u8`} WHERE id = ${id} AND playback_id IS NULL`
    }
    if (legacy.length) console.log(`[virvi-server] pre-push upgrade: backfilled playback_id on ${legacy.length} stream(s)`)
  }
  console.log('[virvi-server] pre-push upgrade: legacy analytics tables cleared, scene_state dropped, deployment_wallets retired, playback_id ensured')
} finally {
  await sql.end()
}
