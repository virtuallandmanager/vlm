import postgres from 'postgres'
import { randomBytes } from 'node:crypto'
import { config } from '../config.js'

const SLUG_RE = /^[a-z0-9-]{3,30}$/

export function assertWorldSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) throw new Error(`invalid world slug: ${JSON.stringify(slug)}`)
}

/**
 * Name of a world's Postgres role and schema (and the `DB_SCHEMA` the world runs with). Hyphens become underscores;
 * slugs never contain underscores, so the mapping is one-to-one.
 */
export function worldDbName(slug: string): string {
  assertWorldSlug(slug)
  return `world_${slug.replace(/-/g, '_')}`
}

const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`

function adminSql(adminUrl?: string) {
  const url = adminUrl ?? config.hyperfyWorldsDatabaseUrl
  if (!url) throw new Error('HYPERFY_WORLDS_DATABASE_URL is not set')
  return postgres(url, { max: 1, onnotice: () => {} })
}

const MIN_PG_VERSION_NUM = 150000

/** The `public` schema isolation relies on Postgres 15+ defaults (no CREATE for PUBLIC), so older servers are refused. */
export function assertSupportedPostgres(versionNum: number): void {
  if (!(versionNum >= MIN_PG_VERSION_NUM)) {
    throw new Error(`worlds database must run Postgres 15 or newer (server_version_num ${versionNum})`)
  }
}

/** postgres.js attaches the failed statement (with the role password) to its errors; keep only message and code. */
function scrub(err: unknown): Error {
  const e = err as { message?: string; code?: string }
  return new Error(`worlds database error${e.code ? ` ${e.code}` : ''}: ${e.message ?? 'unknown'}`)
}

/** Creates the world's role (LOGIN, random password) and a schema it owns; it can use nothing else. */
export async function createWorldDatabase(slug: string, adminUrl?: string): Promise<{ dbUri: string; schema: string }> {
  const name = worldDbName(slug)
  const template = config.hyperfyWorldsDbUrlTemplate
  if (!template) throw new Error('HYPERFY_WORLDS_DB_URL_TEMPLATE is not set')
  const password = randomBytes(32).toString('hex')
  const sql = adminSql(adminUrl)
  try {
    const [{ v }] = await sql`SELECT current_setting('server_version_num')::int AS v`
    assertSupportedPostgres(v as number)
    try {
      await sql.unsafe(`CREATE ROLE ${q(name)} LOGIN PASSWORD ${lit(password)}`)
    } catch (err) {
      throw scrub(err)
    }
    let schemaCreated = false
    try {
      await sql.unsafe(`CREATE SCHEMA ${q(name)} AUTHORIZATION ${q(name)}`)
      schemaCreated = true
      await sql.unsafe(`REVOKE CREATE ON SCHEMA public FROM ${q(name)}`)
    } catch (err) {
      if (schemaCreated) await sql.unsafe(`DROP SCHEMA IF EXISTS ${q(name)} CASCADE`).catch(() => {})
      await sql.unsafe(`DROP ROLE IF EXISTS ${q(name)}`).catch(() => {})
      throw scrub(err)
    }
  } finally {
    await sql.end({ timeout: 5 })
  }
  const dbUri = template
    .replace('{user}', () => encodeURIComponent(name))
    .replace('{password}', () => encodeURIComponent(password))
  return { dbUri, schema: name }
}

/** Drops the world's schema (CASCADE) and role. Safe to call again. */
export async function dropWorldDatabase(slug: string, adminUrl?: string): Promise<void> {
  const name = worldDbName(slug)
  const sql = adminSql(adminUrl)
  try {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${q(name)} CASCADE`)
    const [role] = await sql`SELECT 1 FROM pg_roles WHERE rolname = ${name}`
    if (role) {
      await sql.unsafe(`DROP OWNED BY ${q(name)}`)
      await sql.unsafe(`DROP ROLE ${q(name)}`)
    }
  } finally {
    await sql.end({ timeout: 5 })
  }
}
