/**
 * The hosted-worlds sweep: ends temporary worlds at their end date, purges ended worlds after the retention window,
 * fails worlds stuck in provisioning, and reaps worlds DB job machines left behind. Every transition is a conditional UPDATE … RETURNING, so concurrent sweeps
 * (or servers) claim each world once.
 */

import { and, eq, isNotNull, isNull, lte, or, sql } from 'drizzle-orm'
import { HOSTED_WORLD_RETENTION_DAYS } from '@virvixr/shared'
import { config } from '../config.js'
import { db } from '../db/connection.js'
import { hyperfyWorlds } from '../db/schema.js'
import { worldsDbMode } from '../services/hyperfy/infrastructure.js'
import { JOB_MACHINE_PREFIX } from './fly.js'
import { cleanUp, destroyHostedWorld, withDeps, type HostingDeps } from './hosting.js'

export type SweepDeps = HostingDeps

export const SWEEP_INTERVAL_MS = 5 * 60_000
/** The health wait is 180 s; a create still `provisioning` after this has been lost (e.g. the server restarted). */
const STUCK_AFTER_MS = 10 * 60_000
const DAY_MS = 24 * 60 * 60_000
/** Jobs time out after 120 s and delete their machine; one still there after this was left behind. */
const ORPHAN_JOB_AFTER_MS = 10 * 60_000

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export async function sweepHostedWorlds(now: Date, deps?: Partial<SweepDeps>): Promise<{ ended: number; purged: number; stuck: number }> {
  const d = withDeps(deps)
  const ended = await endDueWorlds(now, d)
  const purged = await purgeEndedWorlds(now, d)
  const stuck = await failStuckWorlds(now, d)
  await reapJobMachines(now, d)
  return { ended, purged, stuck }
}

async function endDueWorlds(now: Date, d: SweepDeps): Promise<number> {
  const claimed = await db
    .update(hyperfyWorlds)
    .set({ status: 'ended', endedAt: now, purgeAfter: new Date(now.getTime() + HOSTED_WORLD_RETENTION_DAYS * DAY_MS) })
    .where(and(eq(hyperfyWorlds.kind, 'hosted'), eq(hyperfyWorlds.status, 'running'), lte(hyperfyWorlds.endsAt, now)))
    .returning({ id: hyperfyWorlds.id, slug: hyperfyWorlds.slug, flyApp: hyperfyWorlds.flyApp })
  for (const w of claimed) d.log.info({ worldId: w.id, slug: w.slug }, 'hosted world ended')
  // Every ended world whose machines aren't yet confirmed down with autostart off: just ended, or an earlier try failed.
  const pending = await db
    .select({ id: hyperfyWorlds.id, ownerId: hyperfyWorlds.ownerId, slug: hyperfyWorlds.slug, flyApp: hyperfyWorlds.flyApp })
    .from(hyperfyWorlds)
    .where(
      and(
        eq(hyperfyWorlds.kind, 'hosted'),
        eq(hyperfyWorlds.status, 'ended'),
        isNull(hyperfyWorlds.purgeClaimedAt),
        isNull(hyperfyWorlds.quiescedAt),
        isNotNull(hyperfyWorlds.flyApp),
      ),
    )
  for (const w of pending) await quiesce(w, now, d)
  return claimed.length
}

/**
 * Makes an ended world unreachable: every machine gets autostart off, then is stopped if running. Failures are logged
 * and the world stays pending for the next pass; they never stop the sweep for other worlds. Runs under the owner's
 * hosted-world lock (as restore and create do) and re-reads the row there, so a restore that landed after the sweep
 * read it is never undone.
 */
async function quiesce(w: { id: string; ownerId: string; slug: string | null; flyApp: string | null }, now: Date, d: SweepDeps): Promise<void> {
  if (!w.flyApp) return
  const app = w.flyApp
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`hyperfy-hosted:${w.ownerId}`}))`)
      const [cur] = await tx.select().from(hyperfyWorlds).where(eq(hyperfyWorlds.id, w.id))
      if (!cur || cur.status !== 'ended' || cur.purgeClaimedAt || cur.quiescedAt) return
      for (const m of await d.fly.listMachines(app)) {
        const env = await d.fly.getMachineEnv(app, m.id)
        await d.fly.updateMachine(app, m.id, { image: requireImage(), env, autostart: false })
        if (m.state !== 'stopped' && m.state !== 'suspended') await d.fly.stopMachine(app, m.id)
      }
      await tx.update(hyperfyWorlds).set({ quiescedAt: now }).where(eq(hyperfyWorlds.id, w.id))
    })
  } catch (err) {
    d.log.error({ worldId: w.id, slug: w.slug, app, error: errText(err) }, 'ended hosted world: machines not stopped; will retry')
  }
}

function requireImage(): string {
  if (!config.hyperfyImage) throw new Error('HYPERFY_IMAGE is not set')
  return config.hyperfyImage
}

async function purgeEndedWorlds(now: Date, d: SweepDeps): Promise<number> {
  const retryBefore = new Date(now.getTime() - SWEEP_INTERVAL_MS)
  const due = await db
    .select({ id: hyperfyWorlds.id, purgeClaimedAt: hyperfyWorlds.purgeClaimedAt })
    .from(hyperfyWorlds)
    .where(
      and(
        eq(hyperfyWorlds.kind, 'hosted'),
        eq(hyperfyWorlds.status, 'ended'),
        lte(hyperfyWorlds.purgeAfter, now),
        // A claim on a row that still exists is a destroy that failed; retry it once it is a sweep old.
        or(isNull(hyperfyWorlds.purgeClaimedAt), lte(hyperfyWorlds.purgeClaimedAt, retryBefore)),
      ),
    )
  let purged = 0
  for (const w of due) {
    // The claim never sets purgedAt: that would release the slug while the row (and its resources) still exist.
    const [won] = await db
      .update(hyperfyWorlds)
      .set({ purgeClaimedAt: now })
      .where(
        and(
          eq(hyperfyWorlds.id, w.id),
          eq(hyperfyWorlds.status, 'ended'),
          w.purgeClaimedAt ? eq(hyperfyWorlds.purgeClaimedAt, w.purgeClaimedAt) : isNull(hyperfyWorlds.purgeClaimedAt),
        ),
      )
      .returning({ id: hyperfyWorlds.id })
    if (!won) continue
    try {
      await destroyHostedWorld(w.id, d)
      purged++
    } catch (err) {
      d.log.error({ worldId: w.id, error: errText(err) }, 'hosted world purge failed; will retry')
    }
  }
  return purged
}

async function failStuckWorlds(now: Date, d: SweepDeps): Promise<number> {
  const claimed = await db
    .update(hyperfyWorlds)
    .set({ status: 'failed', errorMessage: "Setup didn't finish in time" })
    .where(
      and(
        eq(hyperfyWorlds.kind, 'hosted'),
        eq(hyperfyWorlds.status, 'provisioning'),
        lte(hyperfyWorlds.createdAt, new Date(now.getTime() - STUCK_AFTER_MS)),
      ),
    )
    .returning()
  for (const w of claimed) {
    d.log.error({ worldId: w.id, slug: w.slug }, 'hosted world stuck in provisioning; marked failed')
    // We can't know how far the create got, so remove whatever may exist (each step is safe to repeat).
    await cleanUp(w, d, { database: true, app: true, files: true })
  }
  return claimed.length
}

/**
 * Force-deletes worlds DB job machines that are no longer running and are older than ORPHAN_JOB_AFTER_MS: a delete
 * that failed, or a create whose response was lost. Their config holds the statements (and so a role password).
 * Logs only machine ids.
 */
async function reapJobMachines(now: Date, d: SweepDeps): Promise<void> {
  if (worldsDbMode() !== 'fly-job' || !config.hyperfyDbJobApp) return
  const app = config.hyperfyDbJobApp
  let machines: { id: string; state: string; name?: string; createdAt?: string }[]
  try {
    machines = await d.fly.listMachines(app)
  } catch (err) {
    d.log.error({ app, error: errText(err) }, 'could not list worlds DB job machines; will retry')
    return
  }
  const cutoff = now.getTime() - ORPHAN_JOB_AFTER_MS
  for (const m of machines) {
    const created = m.createdAt ? Date.parse(m.createdAt) : NaN
    if (!m.name?.startsWith(JOB_MACHINE_PREFIX) || m.state === 'started' || m.state === 'starting' || !(created <= cutoff)) continue
    try {
      await d.fly.deleteMachine(app, m.id)
      d.log.info({ app, machineId: m.id }, 'deleted a left-behind worlds DB job machine')
    } catch (err) {
      d.log.error({ app, machineId: m.id, error: errText(err) }, 'could not delete a left-behind worlds DB job machine; will retry')
    }
  }
}

export function startHostedWorldSweep(intervalMs: number): () => void {
  if (intervalMs <= 0) return () => {}
  let running = false
  const timer = setInterval(async () => {
    if (running) return
    running = true
    try {
      await sweepHostedWorlds(new Date())
    } catch (err) {
      console.error('[virvi-server] Hosted world sweep failed:', errText(err))
    } finally {
      running = false
    }
  }, intervalMs)
  return () => clearInterval(timer)
}
