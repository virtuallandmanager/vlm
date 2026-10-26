/**
 * Worlds database admin: each world gets a role and a schema of the same name that it alone can use.
 *
 * The SQL is built here and run by a WorldDbRunner, always as one transaction with the Postgres version check first, so a
 * statement that fails rolls the whole batch back. On Fly the worlds database is reachable only inside Fly's private
 * network, so `flyJobRunner` runs the statements in a one-shot machine (infra/hyperfy/db-job.mjs in the world image);
 * `directRunner` runs the same statements from this process, for tests, local dev and `HYPERFY_WORLDS_DB_MODE=direct`.
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
/**
 * Runs the statements in one transaction, in order; rejects with an error that carries no SQL text or params:
 * WorldDbJobFailed when the batch is known to have rolled back, any other error when the outcome is unknown.
 */
export type WorldDbRunner = (statements: WorldDbStatement[]) => Promise<void>

/**
 * A batch that failed on one of its statements and was rolled back, so it changed nothing: a job that exited 1, or a
 * statement error in directRunner. Any other failure (Fly errors, timeouts, a lost COMMIT) may have committed.
 */
export class WorldDbJobFailed extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorldDbJobFailed'
  }
}

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

/**
 * The role (LOGIN, the given password) and a schema it owns; it can use nothing else. The admin needs only CREATEROLE
 * (and CREATE on the database), not superuser: on Postgres 16+ a CREATEROLE admin gets ADMIN OPTION on the roles it
 * creates but not membership, and `CREATE SCHEMA … AUTHORIZATION` needs the admin to be able to SET ROLE to the owner,
 * so it grants itself the new role first (harmless on 15, where CREATEROLE could already do this).
 */
export function createWorldStatements(slug: string, password: string): WorldDbStatement[] {
  const name = worldDbName(slug)
  return [
    postgresVersionCheck(),
    { sql: `CREATE ROLE ${q(name)} LOGIN PASSWORD ${lit(password)}` },
    { sql: `GRANT ${q(name)} TO CURRENT_USER` },
    { sql: `CREATE SCHEMA ${q(name)} AUTHORIZATION ${q(name)}` },
    { sql: `REVOKE CREATE ON SCHEMA public FROM ${q(name)}` },
  ]
}

/**
 * Drops the world's schema (CASCADE) and its role if there is one; safe to run again. A non-superuser admin must be a
 * member of the role to drop what it owns, so it grants itself membership first (its CREATEROLE ADMIN OPTION allows it).
 */
export function dropWorldStatements(slug: string): WorldDbStatement[] {
  const name = worldDbName(slug)
  const ifRole = (body: string) =>
    `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${lit(name)}) THEN ${body} END IF; END $$`
  return [
    postgresVersionCheck(),
    { sql: ifRole(`EXECUTE ${lit(`GRANT ${q(name)} TO CURRENT_USER`)};`) },
    { sql: `DROP SCHEMA IF EXISTS ${q(name)} CASCADE` },
    { sql: ifRole(`EXECUTE ${lit(`DROP OWNED BY ${q(name)}`)}; EXECUTE ${lit(`DROP ROLE ${q(name)}`)};`) },
  ]
}

/**
 * Postgres errors (and postgres.js, which attaches the failed statement) can carry the role password; keep only the
 * statement's position, the code and the message. db-job.mjs prints the same line.
 */
function scrub(err: unknown, where = ''): string {
  const e = err as { message?: string; code?: string }
  return `worlds database error${where}${e.code ? ` ${e.code}` : ''}: ${e.message ?? 'unknown'}`
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
      // A server error on a statement aborts the transaction before COMMIT; anything else (connection, COMMIT) is unknown.
      const onStatement = index >= 0 && index < statements.length
      if (onStatement && (err as Error)?.name === 'PostgresError') {
        throw new WorldDbJobFailed(scrub(err, ` (statement ${index + 1} of ${statements.length})`))
      }
      throw new Error(scrub(err, index === statements.length ? ' at commit' : ''))
    } finally {
      await sql.end({ timeout: 5 })
    }
  }
}

export const DB_JOB_CMD = ['node', '/app/virvi/db-job.mjs']

/**
 * Runs the statements in a one-shot machine of the DB job app, inside Fly's private network. The admin URL is the jobs
 * app's Fly secret `DB_ADMIN_URL`, never sent from here. The statements (which may hold a role password) travel only in
 * the machine's env as base64 JSON; the job prints only the Postgres error, to the machine's logs, and the Machines API
 * gives back only the exit code: 1 means a statement failed and the batch rolled back, anything else is unknown.
 */
export function flyJobRunner(fly: Pick<FlyApi, 'runJob'>, opts?: { app?: string; image?: string }): WorldDbRunner {
  return async (statements) => {
    const app = required(opts?.app ?? config.hyperfyDbJobApp, 'HYPERFY_DB_JOB_APP')
    const image = required(opts?.image ?? config.hyperfyImage, 'HYPERFY_IMAGE')
    const env = { DB_STATEMENTS: Buffer.from(JSON.stringify(statements), 'utf8').toString('base64') }
    const { exitCode } = await fly.runJob(app, { image, env, cmd: DB_JOB_CMD })
    if (exitCode === 0) return
    const message = `worlds database job failed with exit code ${exitCode} (its Postgres error is in the logs of Fly app ${app})`
    throw exitCode === 1 ? new WorldDbJobFailed(message) : new Error(`${message}; the outcome is unknown`)
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

/** Prefixes the step; a WorldDbJobFailed stays one, so callers still know nothing was changed. */
const labelled = (label: string, err: unknown) => {
  const message = `${label} failed: ${err instanceof Error ? err.message : String(err)}`
  return err instanceof WorldDbJobFailed ? new WorldDbJobFailed(message) : new Error(message)
}

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
