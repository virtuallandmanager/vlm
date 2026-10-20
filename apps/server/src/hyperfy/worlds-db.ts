import postgres from 'postgres'
import { randomBytes } from 'node:crypto'

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
  const url = adminUrl ?? process.env.HYPERFY_WORLDS_DATABASE_URL
  if (!url) throw new Error('HYPERFY_WORLDS_DATABASE_URL is not set')
  return postgres(url, { max: 1, onnotice: () => {} })
}

async function currentDb(sql: postgres.Sql): Promise<string> {
  const [row] = await sql`SELECT current_database() AS name`
  return row.name as string
}

/** Creates the world's role (LOGIN, random password) and a schema it owns; it can use nothing else. */
export async function createWorldDatabase(slug: string, adminUrl?: string): Promise<{ dbUri: string; schema: string }> {
  const name = worldDbName(slug)
  const template = process.env.HYPERFY_WORLDS_DB_URL_TEMPLATE
  if (!template) throw new Error('HYPERFY_WORLDS_DB_URL_TEMPLATE is not set')
  const password = randomBytes(32).toString('hex')
  const sql = adminSql(adminUrl)
  try {
    await sql.unsafe(`CREATE ROLE ${q(name)} LOGIN PASSWORD ${lit(password)}`)
    try {
      await sql.unsafe(`CREATE SCHEMA ${q(name)} AUTHORIZATION ${q(name)}`)
      await sql.unsafe(`REVOKE CREATE ON SCHEMA public FROM ${q(name)}`)
      // Hyperfy boots with CREATE SCHEMA IF NOT EXISTS, which Postgres permission-checks even when the schema exists
      await sql.unsafe(`GRANT CREATE ON DATABASE ${q(await currentDb(sql))} TO ${q(name)}`)
    } catch (err) {
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${q(name)} CASCADE`).catch(() => {})
      await sql.unsafe(`DROP ROLE IF EXISTS ${q(name)}`).catch(() => {})
      throw err
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
