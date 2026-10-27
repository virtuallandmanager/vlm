// Test for the worlds DB job (infra/hyperfy/db-job.mjs): runs it with node against the local Postgres, the way a Fly job
// machine runs it, and checks that statements commit together, that a failure rolls back, exits 1 and prints no SQL, and
// that nothing after COMMIT can turn a committed batch into exit 1.
//
//   node infra/hyperfy/test-db-job.mjs <hyperfy-src-dir>
//
// The job uses the `pg` package from the world image's node_modules, so this takes a Hyperfy source dir at b4081eb with
// `npm ci` done (its node_modules is linked in beside a copy of the job). Uses TEST_DATABASE_URL, default as in
// apps/server/vitest.config.ts.
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../..')
const srcDir = path.resolve(process.argv[2] || '')
if (!process.argv[2] || !existsSync(path.join(srcDir, 'node_modules/pg'))) {
  console.error('usage: node infra/hyperfy/test-db-job.mjs <hyperfy src dir with node_modules/pg>')
  process.exit(2)
}
const adminUrl = process.env.TEST_DATABASE_URL ||
  readFileSync(path.join(repoRoot, 'apps/server/vitest.config.ts'), 'utf8').match(/TEST_DATABASE_URL \|\| '([^']+)'/)[1]

const work = mkdtempSync(path.join(tmpdir(), 'virvi-db-job-'))
symlinkSync(path.join(srcDir, 'node_modules'), path.join(work, 'node_modules'))
copyFileSync(path.join(here, 'db-job.mjs'), path.join(work, 'db-job.mjs'))
const { Client } = createRequire(path.join(srcDir, 'package.json'))('pg')

const suffix = Math.random().toString(36).slice(2, 8)
const role = `world_dbjob_${suffix}`
const SECRET = `pw_dbjob_${suffix}`

// Preloads that break the job after COMMIT: pg's client.end() rejects, or the success line throws.
const preload = (name, body) => {
  writeFileSync(path.join(work, name), `import { createRequire } from 'node:module'\nconst require = createRequire(import.meta.url)\n${body}\n`)
  return ['--import', `./${name}`]
}
const endRejects = preload('end-rejects.mjs', `require('pg').Client.prototype.end = function () { return Promise.reject(new Error('end failed')) }`)
const logThrows = preload('log-throws.mjs', `console.log = () => { throw new Error('EPIPE') }`)

function runJob(statements, env = {}, nodeArgs = []) {
  const r = spawnSync(process.execPath, [...nodeArgs, path.join(work, 'db-job.mjs')], {
    cwd: work,
    env: {
      PATH: process.env.PATH,
      DB_ADMIN_URL: adminUrl,
      DB_STATEMENTS: Buffer.from(JSON.stringify(statements)).toString('base64'),
      ...env,
    },
    encoding: 'utf8',
    timeout: 30_000,
  })
  return { code: r.status, out: `${r.stdout}${r.stderr}` }
}

let failed = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : `: ${detail}`}`)
  if (!ok) failed++
}

const admin = new Client({ connectionString: adminUrl })
await admin.connect()
const exists = async () => ({
  role: (await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount === 1,
  schema: (await admin.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [role])).rowCount === 1,
})
const create = [
  { sql: `CREATE ROLE "${role}" LOGIN PASSWORD '${SECRET}'` },
  { sql: `CREATE SCHEMA "${role}" AUTHORIZATION "${role}"` },
]

try {
  // Utility statements can't take params, so the params case uses a plain query.
  const ok = runJob([create[0], create[1], { sql: 'SELECT $1::int AS n', params: [7] }])
  check('success exits 0', ok.code === 0, ok.out)
  check('success commits every statement', JSON.stringify(await exists()) === '{"role":true,"schema":true}')
  check('success prints no SQL or password', !ok.out.includes(SECRET) && !/CREATE|SELECT/.test(ok.out), ok.out)

  await admin.query(`DROP SCHEMA "${role}" CASCADE`)
  await admin.query(`DROP ROLE "${role}"`)
  const bad = runJob([create[0], create[1], { sql: 'SELECT 1 / 0' }])
  check('a failing statement exits 1', bad.code === 1, `exit ${bad.code}: ${bad.out}`)
  check('a failure rolls back the whole batch', JSON.stringify(await exists()) === '{"role":false,"schema":false}')
  check('the failure prints the Postgres code and message', /22012/.test(bad.out) && /division by zero/.test(bad.out), bad.out)
  check('the failure says which statement failed', /statement 3 of 3/.test(bad.out), bad.out)
  check('the failure prints no statement text or password', !bad.out.includes(SECRET) && !/CREATE|SELECT/.test(bad.out), bad.out)

  const version = runJob([{ sql: `DO $$ BEGIN IF current_setting('server_version_num')::int < 9990000 THEN RAISE EXCEPTION 'worlds database must run Postgres 999 or newer'; END IF; END $$` }])
  check('a raised error is printed', version.code === 1 && /P0001/.test(version.out) && /Postgres 999 or newer/.test(version.out), version.out)

  // A deferred unique constraint fails at COMMIT: the job can't tell a refused COMMIT from a lost one, so it exits 2.
  const atCommit = runJob([
    { sql: `CREATE TEMP TABLE dbjob_${suffix} (id int UNIQUE DEFERRABLE INITIALLY DEFERRED)` },
    { sql: `INSERT INTO dbjob_${suffix} VALUES (1), (1)` },
  ])
  check('a failure at COMMIT exits 2 (outcome unknown)', atCommit.code === 2 && /23505/.test(atCommit.out) && /at commit/.test(atCommit.out), `exit ${atCommit.code}: ${atCommit.out}`)
  check('a failure at COMMIT prints no statement text', !/CREATE|INSERT/.test(atCommit.out), atCommit.out)

  // After COMMIT the batch is in: nothing that goes wrong then may exit 1, which the server reads as "rolled back".
  for (const [what, args] of [['client.end() rejects', endRejects], ['printing the success line throws', logThrows]]) {
    await admin.query(`DROP SCHEMA IF EXISTS "${role}" CASCADE`)
    await admin.query(`DROP ROLE IF EXISTS "${role}"`)
    const late = runJob(create, {}, args)
    check(`after COMMIT, ${what}: still exits 0`, late.code === 0, `exit ${late.code}: ${late.out}`)
    check(`after COMMIT, ${what}: the batch is committed`, JSON.stringify(await exists()) === '{"role":true,"schema":true}')
  }

  const noEnv = runJob([], { DB_STATEMENTS: '' })
  check('missing statements exits 1', noEnv.code === 1, noEnv.out)
  const badUrl = runJob(create, { DB_ADMIN_URL: `postgres://nobody:${SECRET}@127.0.0.1:9/x` })
  check('an unreachable database exits 1 without the password', badUrl.code === 1 && !badUrl.out.includes(SECRET), badUrl.out)
} finally {
  await admin.query(`DROP SCHEMA IF EXISTS "${role}" CASCADE`).catch(() => {})
  await admin.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => {})
  await admin.end()
  rmSync(work, { recursive: true, force: true })
}
console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
process.exit(failed ? 1 : 0)
