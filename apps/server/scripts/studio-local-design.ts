/**
 * Makes a design for a hand-run studio worker (scripts/studio-local.md): a local user, a design, and a worker token
 * for it. Prints them as JSON. Local development only: it signs an access token with this server's JWT_SECRET.
 *
 *   DATABASE_URL=... JWT_SECRET=... pnpm exec tsx scripts/studio-local-design.ts [wearable|emote] [claude|codex]
 */
import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { createSigner } from 'fast-jwt'
import { db } from '../src/db/connection.js'
import { users, studioDesigns } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { hashWorkerToken } from '../src/studio/machines.js'

const EMAIL = 'studio-local@virvi.test'
const [kind = 'wearable', agent = 'codex'] = process.argv.slice(2)

if (config.mode === 'cloud' && !config.publicUrl.includes('localhost') && !config.publicUrl.includes('host.docker.internal')) {
  throw new Error('studio-local-design is for a local server only')
}
let [user] = await db.select().from(users).where(eq(users.email, EMAIL))
if (!user) [user] = await db.insert(users).values({ email: EMAIL, displayName: 'Studio Local', role: 'creator' }).returning()
const workerToken = randomBytes(32).toString('base64url')
const [design] = await db.insert(studioDesigns).values({
  ownerId: user.id, name: 'Local design', kind, agent, machineId: 'local', workerTokenHash: hashWorkerToken(workerToken),
}).returning()
const accessToken = createSigner({ key: config.jwtSecret, expiresIn: 2 * 3600_000 })({
  id: user.id, email: user.email, role: user.role, orgId: null, wallet: null, verified: true, kind: 'account',
})
console.log(JSON.stringify({ designId: design.id, workerToken, accessToken }))
process.exit(0)
