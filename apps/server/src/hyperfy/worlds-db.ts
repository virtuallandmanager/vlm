/**
 * Worlds database admin: each world gets a role and a schema of the same name that it alone can use.
 *
 * The SQL is built here and run by a WorldDbRunner, always as one transaction with the Postgres version check first, so a
 * failure leaves nothing behind. On Fly the worlds database is reachable only inside Fly's private network, so
 * `flyJobRunner` runs the statements in a one-shot machine (infra/hyperfy/db-job.mjs in the world image); `directRunner`
 * runs the same statements from this process, for tests, local dev and `HYPERFY_WORLDS_DB_MODE=direct`.
 */
import postgres from 'postgres'
import { randomBytes } from 'node:crypto'
import { config } from '../config.js'
import { worldsDbMode } from '../services/hyperfy/infrastructure.js'
import { FlyApi } from './fly.js'

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

export type WorldDbStatement = { sql: string; params?: (string | number | boolean | null)[] }
/** Runs the statements in one transaction, in order; rejects with an error that carries no SQL text or params. */
export type WorldDbRunner = (statements: WorldDbStatement[]) => Promise<void>

const MIN_PG_VERSION_NUM = 150000

/**
 * Refuses servers below `minVersionNum`: the `public` schema isolation relies on Postgres 15+ defaults (no CREATE for
 * PUBLIC). The first statement of every batch.
 */
export function postgresVersionCheck(minVersionNum = MIN_PG_VERSION_NUM): WorldDbStatement {
  const major = Math.floor(minVersionNum / 10000)
  return {
    sql:
      `DO $$ BEGIN IF current_setting('server_version_num')::int < ${minVersionNum} THEN ` +
      `RAISE EXCEPTION 'worlds database must run Postgres ${major} or newer (server_version_num %)', current_setting('server_version_num'); ` +
      `END IF; END $$`,
  }
}

/** The role (LOGIN, the given password) and a schema it owns; it can use nothing else. */
export function createWorldStatements(slug: string, password: string): WorldDbStatement[] {
  const name = worldDbName(slug)
  return [
    postgresVersionCheck(),
    { sql: `CREATE ROLE ${q(name)} LOGIN PASSWORD ${lit(password)}` },
    { sql: `CREATE SCHEMA ${q(name)} AUTHORIZATION ${q(name)}` },
    { sql: `REVOKE CREATE ON SCHEMA public FROM ${q(name)}` },
  ]
}

/** Drops the world's schema (CASCADE) and its role if there is one; safe to run again. */
export function dropWorldStatements(slug: string): WorldDbStatement[] {
  const name = worldDbName(slug)
  return [
    postgresVersionCheck(),
    { sql: `DROP SCHEMA IF EXISTS ${q(name)} CASCADE` },
    {
      sql:
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${lit(name)}) THEN ` +
        `EXECUTE ${lit(`DROP OWNED BY ${q(name)}`)}; EXECUTE ${lit(`DROP ROLE ${q(name)}`)}; END IF; END $$`,
    },
  ]
}

/**
 * Postgres errors (and postgres.js, which attaches the failed statement) can carry the role password; keep only the
 * statement's position, the code and the message. db-job.mjs prints the same line.
 */
function scrub(err: unknown, at?: { index: number; count: number }): Error {
  const e = err as { message?: string; code?: string }
  const where = at ? ` (statement ${at.index + 1} of ${at.count})` : ''
  return new Error(`worlds database error${where}${e.code ? ` ${e.code}` : ''}: ${e.message ?? 'unknown'}`)
}

/** Runs the statements from this process, in one transaction, against the admin URL. */
export function directRunner(adminUrl: string): WorldDbRunner {
  return async (statements) => {
    const sql = postgres(adminUrl, { max: 1, onnotice: () => {} })
    let index = -1
    try {
      await sql.begin(async (tx) => {
        for (index = 0; index < statements.length; index++) {
          const s = statements[index]
          await tx.unsafe(s.sql, (s.params ?? []) as postgres.ParameterOrJSON<never>[])
        }
      })
    } catch (err) {
      throw scrub(err, index >= 0 && index < statements.length ? { index, count: statements.length } : undefined)
    } finally {
      await sql.end({ timeout: 5 })
    }
  }
}

export const DB_JOB_CMD = ['node', '/app/vlm/db-job.mjs']

/**
 * Runs the statements in a one-shot machine of the DB job app, inside Fly's private network. The statements (which may
 * hold a role password) travel only in the machine's env as base64 JSON; the job prints only the Postgres error, to the
 * machine's logs, and the Machines API gives back only the exit code.
 */
export function flyJobRunner(
  fly: Pick<FlyApi, 'runJob'>,
  opts?: { app?: string; image?: string; adminUrl?: string },
): WorldDbRunner {
  return async (statements) => {
    const app = required(opts?.app ?? config.hyperfyDbJobApp, 'HYPERFY_DB_JOB_APP')
    const image = required(opts?.image ?? config.hyperfyImage, 'HYPERFY_IMAGE')
    const adminUrl = required(opts?.adminUrl ?? config.hyperfyWorldsDatabaseUrl, 'HYPERFY_WORLDS_DATABASE_URL')
    const env = {
      DB_ADMIN_URL: adminUrl,
      DB_STATEMENTS: Buffer.from(JSON.stringify(statements), 'utf8').toString('base64'),
    }
    const { exitCode } = await fly.runJob(app, { image, env, cmd: DB_JOB_CMD })
    if (exitCode !== 0) {
      throw new Error(`worlds database job failed with exit code ${exitCode} (its Postgres error is in the logs of Fly app ${app})`)
    }
  }
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is not set`)
  return value
}

/** The runner HYPERFY_WORLDS_DB_MODE selects (`fly-job` by default on fly). */
export function worldDbRunner(): WorldDbRunner {
  return async (statements) => {
    const mode = worldsDbMode()
    if (mode === 'fly-job') {
      const fly = new FlyApi({ token: config.flyApiToken ?? '', org: config.flyWorldsOrg ?? '' })
      return flyJobRunner(fly)(statements)
    }
    if (mode === 'direct') return directRunner(required(config.hyperfyWorldsDatabaseUrl, 'HYPERFY_WORLDS_DATABASE_URL'))(statements)
    throw new Error(`HYPERFY_WORLDS_DB_MODE must be fly-job or direct`)
  }
}

const labelled = (label: string, err: unknown) => new Error(`${label} failed: ${err instanceof Error ? err.message : String(err)}`)

/** Creates the world's role (LOGIN, random password) and a schema it owns; it can use nothing else. */
export async function createWorldDatabase(slug: string, runner: WorldDbRunner = worldDbRunner()): Promise<{ dbUri: string; schema: string }> {
  const name = worldDbName(slug)
  const template = config.hyperfyWorldsDbUrlTemplate
  if (!template) throw new Error('HYPERFY_WORLDS_DB_URL_TEMPLATE is not set')
  const password = randomBytes(32).toString('hex')
  try {
    await runner(createWorldStatements(slug, password))
  } catch (err) {
    throw labelled('creating the world database', err)
  }
  const dbUri = template
    .replace('{user}', () => encodeURIComponent(name))
    .replace('{password}', () => encodeURIComponent(password))
  return { dbUri, schema: name }
}

/** Drops the world's schema (CASCADE) and role. Safe to call again. */
export async function dropWorldDatabase(slug: string, runner: WorldDbRunner = worldDbRunner()): Promise<void> {
  const statements = dropWorldStatements(slug)
  try {
    await runner(statements)
  } catch (err) {
    throw labelled('dropping the world database', err)
  }
}
