// One-off rewrite of stored URLs from the pre-Virvi domain to virvi.io (rollout R3).
// Usage: DATABASE_URL=… node scripts/rewrite-legacy-urls.mjs [--apply]
//   Without --apply: read-only, prints how many rows each column would change.
//   With --apply: one transaction. Copies each old value to retired.legacy_url_rewrite_20261026, then rewrites it.
//   Running it again changes nothing.
import postgres from 'postgres'
import { fileURLToPath } from 'node:url'

const OLD = String.raw`vlm\.gg` // virvi-rename: keep
const BEFORE = String.raw`(^|[/@"\s])`
const AFTER = String.raw`(?=$|[/:"?#\s])`
const STAGING = new RegExp(`${BEFORE}staging-api\\.${OLD}${AFTER}`, 'g')
const HOST = new RegExp(`${BEFORE}((?:[a-z0-9*-]+\\.)*)${OLD}${AFTER}`, 'g')

/** Old hosts become their virvi.io equivalents (staging-api.<old> → api.staging.virvi.io); look-alikes stay. */
export function rewriteHosts(s) {
  return s.replace(STAGING, '$1api.staging.virvi.io').replace(HOST, '$1$2virvi.io')
}

// The same two patterns for Postgres (ARE: [[:space:]] for \s).
const pg = (re) => re.source.replaceAll(String.raw`\s`, '[:space:]')
const PG_STAGING = pg(STAGING)
const PG_HOST = pg(HOST)

/** Columns holding URLs (found in production on 2026-10-25), with how to read them as text and write them back. */
const COLUMNS = [
  ['asset_library_items', 'cdn_url'],
  ['asset_library_items', 'thumbnail_url'],
  ['media_assets', 'public_url'],
  ['streaming_servers', 'hls_playlist_url'],
  ['streaming_servers', 'rtmp_url'],
  ['scene_elements', 'properties', 'jsonb'],
  ['hyperfy_worlds', 'address'],
]

const RETIRED = 'retired.legacy_url_rewrite_20261026'

/** Per column ("table.column"), the rows that hold an old host; rewritten when `apply` is true. */
export async function rewriteStoredUrls(sql, { apply }) {
  const run = async (tx) => {
    const counts = {}
    if (apply) {
      await tx`CREATE SCHEMA IF NOT EXISTS retired`
      await tx.unsafe(`CREATE TABLE IF NOT EXISTS ${RETIRED} (table_name text NOT NULL, column_name text NOT NULL, row_id text NOT NULL, old_value text NOT NULL, PRIMARY KEY (table_name, column_name, row_id))`)
    }
    for (const [table, column, type] of COLUMNS) {
      const text = `"${column}"::text`
      const where = `${text} ~ $1`
      if (!apply) {
        const [{ n }] = await tx.unsafe(`SELECT count(*)::int AS n FROM "${table}" WHERE ${where}`, [PG_HOST])
        counts[`${table}.${column}`] = n
        continue
      }
      await tx.unsafe(
        `INSERT INTO ${RETIRED} SELECT $2, $3, id::text, ${text} FROM "${table}" WHERE ${where} ON CONFLICT DO NOTHING`,
        [PG_HOST, table, column],
      )
      const next = `regexp_replace(regexp_replace(${text}, $1, '\\1api.staging.virvi.io', 'g'), $2, '\\1\\2virvi.io', 'g')`
      const rows = await tx.unsafe(
        `UPDATE "${table}" SET "${column}" = (${next})${type === 'jsonb' ? '::jsonb' : ''} WHERE ${text} ~ $2 RETURNING id`,
        [PG_STAGING, PG_HOST],
      )
      counts[`${table}.${column}`] = rows.length
    }
    return counts
  }
  return apply ? sql.begin(run) : sql.begin('READ ONLY', run)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL is required')
    process.exit(1)
  }
  const sql = postgres(url, { max: 1, onnotice: () => {} })
  try {
    const apply = process.argv.includes('--apply')
    const counts = await rewriteStoredUrls(sql, { apply })
    for (const [k, n] of Object.entries(counts)) console.log(`${apply ? 'rewrote' : 'would rewrite'} ${n} ${k}`)
  } finally {
    await sql.end()
  }
}
