/**
 * Smokes a studio worker machine's life on the real Fly API: create, stop (the worker can't reach PUBLIC_URL and
 * exits), start again, destroy. Uses a throwaway design row; prints each step and exits non-zero on a failure.
 *
 *   DATABASE_URL=... FLY_API_TOKEN=... FLY_WORLDS_ORG=vlm-worlds STUDIO_WORKER_IMAGE=registry.fly.io/vlm-studio-worker:<tag> \
 *     PUBLIC_URL=https://example.invalid pnpm exec tsx scripts/studio-fly-smoke.ts
 */
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { users, studioDesigns } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { FlyApi } from '../src/hyperfy/fly.js'
import { ensureWorker, destroyWorker } from '../src/studio/machines.js'

const fly = new FlyApi({ token: config.flyApiToken ?? '', org: config.flyWorldsOrg ?? '' })
const app = config.studioFlyApp
const step = (s: string) => console.log(`[smoke] ${s}`)

async function waitFor(id: string, want: string[], ms: number) {
  const end = Date.now() + ms
  let state: string | null = null
  while (Date.now() < end) {
    state = await fly.getMachineState(app, id)
    if (state !== null && want.includes(state)) return state
    await new Promise((r) => setTimeout(r, 3000))
  }
  throw new Error(`machine ${id} stayed ${state}, wanted ${want.join(' or ')}`)
}

const machineOf = async (id: string) => (await db.select().from(studioDesigns).where(eq(studioDesigns.id, id)))[0].machineId

let designId: string | null = null
try {
  if (!config.publicUrl.includes('.invalid')) throw new Error('set PUBLIC_URL to an unreachable https://example.invalid')
  const [u] = await db.insert(users).values({ email: `studio-smoke-${Date.now()}@vlm.test`, displayName: 'Studio smoke' }).returning()
  const [d] = await db.insert(studioDesigns).values({ ownerId: u.id, name: 'Fly smoke', kind: 'wearable', agent: 'claude' }).returning()
  designId = d.id
  await ensureWorker(d.id)
  const id = await machineOf(d.id)
  if (!id) throw new Error('no machine was recorded')
  step(`created ${id}`)
  step(`stopped: ${await waitFor(id, ['stopped'], 5 * 60_000)}`)
  await ensureWorker(d.id)
  step(`started again: ${await waitFor(id, ['started', 'stopping', 'stopped'], 2 * 60_000)}`)
  await destroyWorker(d.id)
  step(`destroyed; state now ${await waitFor(id, ['destroyed', 'destroying'], 60_000).catch(async () => String(await fly.getMachineState(app, id)))}`)
  if (await machineOf(d.id)) throw new Error('the design still names a machine')
  step('PASSED')
  process.exit(0)
} catch (err) {
  console.error('[smoke] FAILED:', err instanceof Error ? err.message : err)
  if (designId) await destroyWorker(designId).catch(() => {})
  process.exit(1)
}
