// Worlds DB job: runs the Virvi server's worlds-database admin statements inside Fly's private network, where the Managed
// Postgres is reachable. The server starts it as a one-shot machine of the world image (/app/virvi/db-job.mjs) with:
//   DB_ADMIN_URL   the cluster's admin URL
//   DB_STATEMENTS  base64 JSON [{ sql, params? }], run in order in one transaction
// Exits 0 when every statement committed (even if something fails afterwards); 1 when nothing was changed (bad input, no
// connection, or a statement failed and the transaction rolled back); 2 when COMMIT failed, so the outcome is unknown. The statements can hold a role
// password, so on failure this prints only which statement failed and Postgres's code and message, never the SQL or
// its params.
import pg from 'pg'

function fail(line, code = 1) {
  console.error(line)
  process.exit(code)
}

let statements
try {
  statements = JSON.parse(Buffer.from(process.env.DB_STATEMENTS || '', 'base64').toString('utf8'))
} catch {
  fail('worlds database job: DB_STATEMENTS is not base64 JSON')
}
if (!Array.isArray(statements) || !statements.length || !statements.every((s) => typeof s?.sql === 'string')) {
  fail('worlds database job: DB_STATEMENTS must be a non-empty list of { sql, params? }')
}
if (!process.env.DB_ADMIN_URL) fail('worlds database job: DB_ADMIN_URL is not set')

const client = new pg.Client({ connectionString: process.env.DB_ADMIN_URL, connectionTimeoutMillis: 15_000 })
// Keep an idle-connection error from becoming an unhandled event; the failing query reports it.
client.on('error', () => {})
let index = -1
let committing = false
let committed = false
// Anything unexpected still reports the batch's real outcome: once COMMIT has returned, exit 1 ("rolled back") would be
// a lie. Only the error's code is printed; its message could quote a statement.
process.on('uncaughtException', (err) => {
  console.error(`worlds database job: unexpected error${typeof err?.code === 'string' ? ` ${err.code}` : ''}`)
  process.exit(committed ? 0 : committing ? 2 : 1)
})
try {
  await client.connect()
  await client.query('BEGIN')
  for (index = 0; index < statements.length; index++) {
    const s = statements[index]
    await client.query(s.sql, s.params ?? [])
  }
  index = -1
  committing = true
  await client.query('COMMIT')
  committed = true
} catch (err) {
  await client.query('ROLLBACK').catch(() => {})
  const where = committing ? ' at commit' : index >= 0 ? ` (statement ${index + 1} of ${statements.length})` : ''
  const code = typeof err?.code === 'string' ? ` ${err.code}` : ''
  await client.end().catch(() => {})
  fail(`worlds database error${where}${code}: ${err?.message ?? 'unknown'}`, committing ? 2 : 1)
}
// Committed: from here on the job exits 0 whatever happens (see the uncaughtException handler above).
console.log(`worlds database job: ${statements.length} statements committed`)
await client.end().catch(() => {})
process.exit(0)
