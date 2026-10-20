import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from 'vitest'
import postgres from 'postgres'
import { config } from '../src/config.js'
import {
  createWorldDatabase, dropWorldDatabase, worldDbName, createWorldStatements, dropWorldStatements, postgresVersionCheck,
  directRunner, flyJobRunner, WorldDbJobFailed, type WorldDbStatement,
} from '../src/hyperfy/worlds-db.js'

const ADMIN_URL = process.env.DATABASE_URL!
// The statements run here exactly as the Fly job runs them: one transaction, version check first.
const direct = directRunner(ADMIN_URL)
const suffix = Math.random().toString(36).slice(2, 8)
const slugA = `t3-a-${suffix}`
const slugB = `t3-b-${suffix}`

let admin: postgres.Sql
const clients: postgres.Sql[] = []

function connect(url: string) {
  const c = postgres(url, { max: 1, onnotice: () => {} })
  clients.push(c)
  return c
}

beforeAll(() => {
  const u = new URL(ADMIN_URL)
  ;(config as any).hyperfyWorldsDbUrlTemplate =
    `postgres://{user}:{password}@${u.host}${u.pathname}`
  admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} })
})

afterEach(async () => {
  for (const c of clients.splice(0)) await c.end({ timeout: 1 }).catch(() => {})
  await admin.unsafe(`DROP TABLE IF EXISTS public.t3_pub_${suffix}`)
  for (const s of [slugA, slugB]) await dropWorldDatabase(s, direct).catch(() => {})
})

afterAll(async () => {
  await admin.end({ timeout: 1 })
})

describe('worlds database', () => {
  it('a world role can create tables in its own schema', async () => {
    const { dbUri, schema } = await createWorldDatabase(slugA, direct)
    expect(schema).toBe(worldDbName(slugA))
    const w = connect(dbUri)
    await w.unsafe(`CREATE TABLE "${schema}".things (id int)`)
    await w.unsafe(`INSERT INTO "${schema}".things VALUES (1)`)
    expect(await w.unsafe(`SELECT id FROM "${schema}".things`)).toHaveLength(1)
    await expect(w.unsafe(`CREATE SCHEMA some_other_name`)).rejects.toThrow(/permission denied/)
  })

  it("a world role can't read or create in another world's schema or in public", async () => {
    const a = await createWorldDatabase(slugA, direct)
    const b = await createWorldDatabase(slugB, direct)
    await admin.unsafe(`CREATE TABLE "${b.schema}".secret (id int)`)
    await admin.unsafe(`GRANT ALL ON "${b.schema}".secret TO "${b.schema}"`)
    await admin.unsafe(`CREATE TABLE public.t3_pub_${suffix} (id int)`)
    const w = connect(a.dbUri)
    await expect(w.unsafe(`SELECT * FROM public.t3_pub_${suffix}`)).rejects.toThrow(/permission denied/)
    await expect(w.unsafe(`SELECT * FROM "${b.schema}".secret`)).rejects.toThrow(/permission denied/)
    await expect(w.unsafe(`CREATE TABLE "${b.schema}".x (id int)`)).rejects.toThrow(/permission denied/)
    await expect(w.unsafe(`CREATE TABLE public.x (id int)`)).rejects.toThrow(/permission denied/)
  })

  it('creating the same world twice is an error, known to have rolled back', async () => {
    await createWorldDatabase(slugA, direct)
    const err = await createWorldDatabase(slugA, direct).catch((e) => e)
    expect(err).toBeInstanceOf(WorldDbJobFailed)
    expect(err.message).toMatch(/^creating the world database failed: .*42710/)
  })

  it("a connection failure is not WorldDbJobFailed: the outcome isn't known", async () => {
    const err = await createWorldDatabase(slugA, directRunner('postgres://nobody:nopw@127.0.0.1:9/x')).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(WorldDbJobFailed)
    expect(err.message).toMatch(/^creating the world database failed/)
  })

  it('a failed create does not leak the password in its error', async () => {
    let dbUri = ''
    ;({ dbUri } = await createWorldDatabase(slugA, direct))
    const password = decodeURIComponent(new URL(dbUri).password)
    const err = await createWorldDatabase(slugA, direct).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    const dump = JSON.stringify(Object.getOwnPropertyNames(err).map((k) => String((err as any)[k])))
    expect(err.message).not.toMatch(/PASSWORD/i)
    expect(dump).not.toContain(password)
    expect(dump).not.toMatch(/PASSWORD/i)
    expect(err.cause).toBeUndefined()
  })

  it('checks for Postgres 15 or newer before anything else', async () => {
    const [first] = createWorldStatements(slugA, 'pw')
    expect(first).toEqual(postgresVersionCheck())
    expect(first.sql).toContain('150000')
    expect(dropWorldStatements(slugA)[0]).toEqual(postgresVersionCheck())
    await expect(direct([postgresVersionCheck()])).resolves.toBeUndefined()
    // The local server is 15+, so stand in for an old one by asking for a newer version than it has.
    const err = await direct([postgresVersionCheck(990000), ...createWorldStatements(slugA, 'pw').slice(1)]).catch((e) => e)
    expect(err.message).toMatch(/worlds database must run Postgres 99 or newer/)
    expect(err.message).toMatch(/statement 1 of 4/)
    expect(postgresVersionCheck().sql).toMatch(/Postgres 15 or newer/)
    expect(await admin`SELECT 1 FROM pg_roles WHERE rolname = ${worldDbName(slugA)}`).toHaveLength(0)
  })

  it('a create runs in one transaction: a failure in any later statement leaves no role and no schema', async () => {
    const name = worldDbName(slugA)
    const failing: WorldDbStatement = { sql: 'SELECT 1 / 0' }
    const err = await direct([...createWorldStatements(slugA, 'pw_hidden_123'), failing]).catch((e) => e)
    expect(err.message).toMatch(/statement 5 of 5/)
    expect(err.message).toMatch(/22012/)
    expect(err.message).not.toContain('pw_hidden_123')
    expect(err.message).not.toContain('SELECT')
    expect(await admin`SELECT 1 FROM pg_roles WHERE rolname = ${name}`).toHaveLength(0)
    expect(await admin`SELECT 1 FROM pg_namespace WHERE nspname = ${name}`).toHaveLength(0)
  })

  it('the password appears only in the CREATE ROLE statement', () => {
    const stmts = createWorldStatements(slugA, 'pw_only_here')
    expect(stmts.filter((s) => JSON.stringify(s).includes('pw_only_here'))).toHaveLength(1)
    expect(stmts.find((s) => s.sql.includes('pw_only_here'))!.sql).toMatch(/^CREATE ROLE/)
    expect(JSON.stringify(dropWorldStatements(slugA))).not.toMatch(/PASSWORD/i)
  })

  it('a failing statement with params reports the error without them', async () => {
    const err = await direct([{ sql: 'SELECT $1::int', params: ['not_a_number_xyz'] }]).catch((e) => e)
    expect(err.message).toMatch(/22P02/)
    expect(err.message).not.toContain('SELECT')
    expect(JSON.stringify(Object.getOwnPropertyNames(err).map((k) => String((err as any)[k])))).not.toContain('$1')
  })

  it('a failure after the role statement rolls the role back and leaves a pre-existing schema alone', async () => {
    const name = worldDbName(slugA)
    await admin.unsafe(`CREATE SCHEMA "${name}"`)
    try {
      await expect(createWorldDatabase(slugA, direct)).rejects.toThrow()
      expect(await admin`SELECT 1 FROM pg_roles WHERE rolname = ${name}`).toHaveLength(0)
      expect(await admin`SELECT 1 FROM pg_namespace WHERE nspname = ${name}`).toHaveLength(1)
    } finally {
      await admin.unsafe(`DROP SCHEMA IF EXISTS "${name}" CASCADE`)
    }
  })

  it('rejects slugs that break the slug rule', async () => {
    for (const bad of ['ab', 'UPPER', 'a_b_c', 'x"; drop', 'a'.repeat(31)]) {
      await expect(createWorldDatabase(bad, direct)).rejects.toThrow(/invalid world slug/)
      await expect(dropWorldDatabase(bad, direct)).rejects.toThrow(/invalid world slug/)
    }
  })

  it('drop removes schema and role, twice is fine', async () => {
    const { schema } = await createWorldDatabase(slugA, direct)
    await admin.unsafe(`CREATE TABLE "${schema}".t (id int)`)
    await dropWorldDatabase(slugA, direct)
    await dropWorldDatabase(slugA, direct)
    expect(await admin`SELECT 1 FROM pg_namespace WHERE nspname = ${schema}`).toHaveLength(0)
    expect(await admin`SELECT 1 FROM pg_roles WHERE rolname = ${schema}`).toHaveLength(0)
  })
})

describe('worlds database through Fly job machines', () => {
  const opts = { app: 'vlm-worlds-db-jobs', image: 'registry.fly.io/vlm-hyperfy-image:abc' }

  it('runs the statements in a job machine, passed as base64 JSON in its env; the admin URL is the app secret, never sent', async () => {
    const savedUrl = (config as any).hyperfyWorldsDatabaseUrl
    ;(config as any).hyperfyWorldsDatabaseUrl = 'postgres://admin:adminpw_x@worlds-db.flycast/postgres'
    const runJob = vi.fn(async () => ({ exitCode: 0 }))
    const stmts = createWorldStatements(slugA, 'pw_job_1')
    await flyJobRunner({ runJob }, opts)(stmts).finally(() => { (config as any).hyperfyWorldsDatabaseUrl = savedUrl })
    expect(runJob).toHaveBeenCalledTimes(1)
    const [app, spec] = runJob.mock.calls[0] as unknown as [string, { image: string; env: Record<string, string>; cmd: string[] }]
    expect(app).toBe('vlm-worlds-db-jobs')
    expect(spec.image).toBe(opts.image)
    expect(spec.cmd).toEqual(['node', '/app/vlm/db-job.mjs'])
    expect(Object.keys(spec.env)).toEqual(['DB_STATEMENTS'])
    expect(JSON.stringify(spec)).not.toContain('adminpw_x')
    expect(JSON.parse(Buffer.from(spec.env.DB_STATEMENTS, 'base64').toString('utf8'))).toEqual(stmts)
  })

  it('a job that exits 1 (a statement failed and was rolled back) is WorldDbJobFailed, with no SQL or password', async () => {
    const runJob = vi.fn(async () => ({ exitCode: 1 }))
    const err = await flyJobRunner({ runJob }, opts)(createWorldStatements(slugA, 'pw_job_2')).catch((e) => e)
    expect(err).toBeInstanceOf(WorldDbJobFailed)
    expect(err.message).toMatch(/exit code 1/)
    expect(err.message).toContain('vlm-worlds-db-jobs')
    const dump = JSON.stringify(Object.getOwnPropertyNames(err).map((k) => String((err as any)[k])))
    for (const hidden of ['pw_job_2', 'adminpw_x', 'CREATE', 'PASSWORD']) expect(dump).not.toContain(hidden)
  })

  it('any other exit code is a plain error: the outcome is unknown', async () => {
    for (const exitCode of [2, 137]) {
      const runJob = vi.fn(async () => ({ exitCode }))
      const err = await flyJobRunner({ runJob }, opts)(createWorldStatements(slugA, 'pw_job_3')).catch((e) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err).not.toBeInstanceOf(WorldDbJobFailed)
      expect(err.message).toContain(`exit code ${exitCode}`)
      expect(err.message).not.toContain('pw_job_3')
    }
  })

  it('Fly errors from the job pass through', async () => {
    const runJob = vi.fn(async () => { throw new Error('Fly POST /apps/vlm-worlds-db-jobs/machines returned 422: no card') })
    await expect(flyJobRunner({ runJob }, opts)(dropWorldStatements(slugA))).rejects.toThrow(/422: no card/)
  })

  it('create and drop say which one failed', async () => {
    const runJob = vi.fn(async () => ({ exitCode: 1 }))
    await expect(createWorldDatabase(slugA, flyJobRunner({ runJob }, opts))).rejects.toThrow(/^creating the world database failed: .*exit code 1/)
    await expect(createWorldDatabase(slugA, flyJobRunner({ runJob }, opts))).rejects.toBeInstanceOf(WorldDbJobFailed)
    await expect(dropWorldDatabase(slugA, flyJobRunner({ runJob }, opts))).rejects.toThrow(/^dropping the world database failed: .*exit code 1/)
  })

  it('in fly-job mode the default runner calls the Fly Machines API for the job app', async () => {
    const keys = ['hyperfyInfraProvider', 'hyperfyWorldsDbMode', 'hyperfyDbJobApp', 'hyperfyImage', 'hyperfyWorldsDatabaseUrl', 'flyApiToken', 'flyWorldsOrg'] as const
    const saved = Object.fromEntries(keys.map((k) => [k, (config as any)[k]]))
    Object.assign(config as any, {
      hyperfyInfraProvider: 'fly', hyperfyWorldsDbMode: undefined, hyperfyDbJobApp: 'vlm-worlds-db-jobs',
      hyperfyImage: opts.image, hyperfyWorldsDatabaseUrl: opts.adminUrl, flyApiToken: 'FlyV1 t', flyWorldsOrg: 'vlm-worlds',
    })
    const urls: string[] = []
    vi.stubGlobal('fetch', async (url: string, init: any) => {
      urls.push(`${init.method} ${url}`)
      if (init.method === 'POST') return new Response(JSON.stringify({ id: 'j1' }), { status: 200 })
      if (url.includes('/wait')) return new Response('{}', { status: 200 })
      if (init.method === 'GET') return new Response(JSON.stringify({ events: [{ type: 'exit', request: { exit_event: { exit_code: 0 } } }] }), { status: 200 })
      return new Response('{}', { status: 200 })
    })
    try {
      await dropWorldDatabase(slugA)
    } finally {
      vi.unstubAllGlobals()
      Object.assign(config as any, saved)
    }
    expect(urls[0]).toBe('POST https://api.machines.dev/v1/apps/vlm-worlds-db-jobs/machines')
    expect(urls.at(-1)).toBe('DELETE https://api.machines.dev/v1/apps/vlm-worlds-db-jobs/machines/j1?force=true')
  })
})
