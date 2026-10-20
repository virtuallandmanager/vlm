import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest'
import postgres from 'postgres'
import { createWorldDatabase, dropWorldDatabase, worldDbName, assertSupportedPostgres } from '../src/hyperfy/worlds-db.js'

const ADMIN_URL = process.env.DATABASE_URL!
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
  process.env.HYPERFY_WORLDS_DB_URL_TEMPLATE =
    `postgres://{user}:{password}@${u.host}${u.pathname}`
  admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} })
})

afterEach(async () => {
  for (const c of clients.splice(0)) await c.end({ timeout: 1 }).catch(() => {})
  await admin.unsafe(`DROP TABLE IF EXISTS public.t3_pub_${suffix}`)
  for (const s of [slugA, slugB]) await dropWorldDatabase(s, ADMIN_URL).catch(() => {})
})

afterAll(async () => {
  await admin.end({ timeout: 1 })
})

describe('worlds database', () => {
  it('a world role can create tables in its own schema', async () => {
    const { dbUri, schema } = await createWorldDatabase(slugA, ADMIN_URL)
    expect(schema).toBe(worldDbName(slugA))
    const w = connect(dbUri)
    await w.unsafe(`CREATE TABLE "${schema}".things (id int)`)
    await w.unsafe(`INSERT INTO "${schema}".things VALUES (1)`)
    expect(await w.unsafe(`SELECT id FROM "${schema}".things`)).toHaveLength(1)
    await expect(w.unsafe(`CREATE SCHEMA some_other_name`)).rejects.toThrow(/permission denied/)
  })

  it("a world role can't read or create in another world's schema or in public", async () => {
    const a = await createWorldDatabase(slugA, ADMIN_URL)
    const b = await createWorldDatabase(slugB, ADMIN_URL)
    await admin.unsafe(`CREATE TABLE "${b.schema}".secret (id int)`)
    await admin.unsafe(`GRANT ALL ON "${b.schema}".secret TO "${b.schema}"`)
    await admin.unsafe(`CREATE TABLE public.t3_pub_${suffix} (id int)`)
    const w = connect(a.dbUri)
    await expect(w.unsafe(`SELECT * FROM public.t3_pub_${suffix}`)).rejects.toThrow(/permission denied/)
    await expect(w.unsafe(`SELECT * FROM "${b.schema}".secret`)).rejects.toThrow(/permission denied/)
    await expect(w.unsafe(`CREATE TABLE "${b.schema}".x (id int)`)).rejects.toThrow(/permission denied/)
    await expect(w.unsafe(`CREATE TABLE public.x (id int)`)).rejects.toThrow(/permission denied/)
  })

  it('creating the same world twice is an error', async () => {
    await createWorldDatabase(slugA, ADMIN_URL)
    await expect(createWorldDatabase(slugA, ADMIN_URL)).rejects.toThrow()
  })

  it('a failed create does not leak the password in its error', async () => {
    let dbUri = ''
    ;({ dbUri } = await createWorldDatabase(slugA, ADMIN_URL))
    const password = decodeURIComponent(new URL(dbUri).password)
    const err = await createWorldDatabase(slugA, ADMIN_URL).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    const dump = JSON.stringify(Object.getOwnPropertyNames(err).map((k) => String((err as any)[k])))
    expect(err.message).not.toMatch(/PASSWORD/i)
    expect(dump).not.toContain(password)
    expect(dump).not.toMatch(/PASSWORD/i)
    expect(err.cause).toBeUndefined()
  })

  it('refuses Postgres older than 15', () => {
    expect(() => assertSupportedPostgres(140012)).toThrow(/Postgres 15/)
    expect(() => assertSupportedPostgres(150000)).not.toThrow()
    expect(() => assertSupportedPostgres(160013)).not.toThrow()
  })

  it('a failure after the role exists removes the role and leaves a pre-existing schema alone', async () => {
    const name = worldDbName(slugA)
    await admin.unsafe(`CREATE SCHEMA "${name}"`)
    try {
      await expect(createWorldDatabase(slugA, ADMIN_URL)).rejects.toThrow()
      expect(await admin`SELECT 1 FROM pg_roles WHERE rolname = ${name}`).toHaveLength(0)
      expect(await admin`SELECT 1 FROM pg_namespace WHERE nspname = ${name}`).toHaveLength(1)
    } finally {
      await admin.unsafe(`DROP SCHEMA IF EXISTS "${name}" CASCADE`)
    }
  })

  it('rejects slugs that break the slug rule', async () => {
    for (const bad of ['ab', 'UPPER', 'a_b_c', 'x"; drop', 'a'.repeat(31)]) {
      await expect(createWorldDatabase(bad, ADMIN_URL)).rejects.toThrow(/invalid world slug/)
      await expect(dropWorldDatabase(bad, ADMIN_URL)).rejects.toThrow(/invalid world slug/)
    }
  })

  it('drop removes schema and role, twice is fine', async () => {
    const { schema } = await createWorldDatabase(slugA, ADMIN_URL)
    await admin.unsafe(`CREATE TABLE "${schema}".t (id int)`)
    await dropWorldDatabase(slugA, ADMIN_URL)
    await dropWorldDatabase(slugA, ADMIN_URL)
    expect(await admin`SELECT 1 FROM pg_namespace WHERE nspname = ${schema}`).toHaveLength(0)
    expect(await admin`SELECT 1 FROM pg_roles WHERE rolname = ${schema}`).toHaveLength(0)
  })
})
