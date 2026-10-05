import postgres from 'postgres'
import { execSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TEST_DATABASE_URL } from '../vitest.config'

const here = dirname(fileURLToPath(import.meta.url))

export default async function setup() {
  const url = new URL(TEST_DATABASE_URL)
  const dbName = url.pathname.slice(1)
  const adminUrl = new URL(TEST_DATABASE_URL)
  adminUrl.pathname = '/postgres'

  const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} })
  await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)
  await admin.unsafe(`CREATE DATABASE ${dbName}`)
  await admin.end()

  execSync('pnpm exec drizzle-kit push --force', {
    cwd: resolve(here, '..'),
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: 'pipe',
  })

  const { ensureVenueConstraints } = await import('../src/db/venue-constraints.js')
  const client = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} })
  await ensureVenueConstraints((q) => client.unsafe(q))
  await client.end()
}
